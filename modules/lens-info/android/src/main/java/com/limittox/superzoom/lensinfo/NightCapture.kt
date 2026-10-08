package com.limittox.superzoom.lensinfo

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.ImageFormat
import android.graphics.SurfaceTexture
import android.hardware.HardwareBuffer
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraExtensionCharacteristics
import android.hardware.camera2.CameraExtensionSession
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.params.ExtensionSessionConfiguration
import android.hardware.camera2.params.OutputConfiguration
import android.media.ImageReader
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Size
import androidx.annotation.RequiresApi
import expo.modules.kotlin.Promise
import java.io.File
import java.util.concurrent.Executor

/**
 * Development only: one still photo through Samsung's (or any vendor's) Night camera extension,
 * Android's only route for apps to the phone's own multi-frame merge. Used for an A/B test
 * against a normal capture (docs/follow-ups.md, "Close the quality gap").
 *
 * It opens the camera itself with Camera2, so VisionCamera must have released it first; opening
 * retries for a few seconds while the camera is still in use. A preview stream (drained, never
 * shown) runs for `warmupMs` before the capture so focus and exposure can settle. If the session
 * refuses the preview output, it retries with the still output alone.
 */
@RequiresApi(Build.VERSION_CODES.S)
internal class NightCapture(
  context: Context,
  private val cameraId: String,
  private val zoomRatio: Float,
  private val warmupMs: Long,
  private val output: File,
) {
  private val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
  private val thread = HandlerThread("NightCapture").apply { start() }
  private val handler = Handler(thread.looper)
  private val executor = Executor { handler.post(it) }
  private val started = SystemClock.elapsedRealtime()
  private val timings = linkedMapOf<String, Long>()

  private lateinit var promise: Promise
  private var device: CameraDevice? = null
  private var session: CameraExtensionSession? = null
  private var stillReader: ImageReader? = null
  private var previewReader: ImageReader? = null
  private var openAttempts = 0
  private var withPreview = true
  private var previewSize: Size? = null
  private var appliedZoom = zoomRatio
  private var previewSeen = false
  private var captureRequested = false
  private var finished = false

  fun run(promise: Promise) {
    this.promise = promise
    handler.post { open() }
    handler.postDelayed({ fail("TIMEOUT", "The Night capture took longer than ${TIMEOUT_MS / 1000} s.") }, TIMEOUT_MS)
  }

  private fun mark(step: String) {
    timings[step] = SystemClock.elapsedRealtime() - started
  }

  @SuppressLint("MissingPermission") // The app only reaches the camera screen with camera permission.
  private fun open() {
    if (finished) return
    openAttempts++
    try {
      manager.openCamera(
        cameraId,
        executor,
        object : CameraDevice.StateCallback() {
          override fun onOpened(camera: CameraDevice) {
            if (finished) return camera.close()
            device = camera
            mark("opened")
            configure(camera)
          }

          override fun onDisconnected(camera: CameraDevice) {
            camera.close()
            if (device == null) retryOpen("disconnected") else fail("DISCONNECTED", "The camera was disconnected.")
          }

          override fun onError(camera: CameraDevice, error: Int) {
            camera.close()
            val inUse = error == ERROR_CAMERA_IN_USE || error == ERROR_MAX_CAMERAS_IN_USE
            if (device == null && inUse) retryOpen("in use") else fail("CAMERA_ERROR", "Camera error $error.")
          }
        },
      )
    } catch (e: Exception) {
      retryOpen("${e.javaClass.simpleName}: ${e.message}")
    }
  }

  private fun retryOpen(reason: String) {
    if (finished) return
    if (openAttempts >= MAX_OPEN_ATTEMPTS) {
      fail("OPEN_FAILED", "Couldn't open camera $cameraId ($reason).")
    } else {
      handler.postDelayed({ open() }, OPEN_RETRY_MS)
    }
  }

  private fun configure(camera: CameraDevice) {
    try {
      val chars = manager.getCameraExtensionCharacteristics(cameraId)
      val ext = CameraExtensionCharacteristics.EXTENSION_NIGHT
      if (ext !in chars.supportedExtensions) return fail("UNSUPPORTED", "This camera has no Night extension.")

      // Keep the zoom inside the extension's own range where the OS reports it (Android 15+).
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) {
        chars.get(ext, CameraCharacteristics.CONTROL_ZOOM_RATIO_RANGE)?.let { appliedZoom = it.clamp(zoomRatio) }
      }

      val still =
        chars.getExtensionSupportedSizes(ext, ImageFormat.JPEG).maxByOrNull { it.width.toLong() * it.height }
          ?: return fail("UNSUPPORTED", "Night offers no JPEG size.")
      stillReader =
        ImageReader.newInstance(still.width, still.height, ImageFormat.JPEG, 1).apply {
          setOnImageAvailableListener({ onStill(it) }, handler)
        }
      val outputs = mutableListOf(OutputConfiguration(stillReader!!.surface))

      if (withPreview) {
        // A preview size near 1080p; the frames are drained, so only 3A needs them.
        val sizes = chars.getExtensionSupportedSizes(ext, SurfaceTexture::class.java)
        val size =
          sizes.filter { it.width * it.height <= 1920 * 1440 }.maxByOrNull { it.width * it.height }
            ?: sizes.minByOrNull { it.width * it.height }
        if (size == null) {
          withPreview = false
        } else {
          previewSize = size
          // PRIVATE + GPU usage is what a SurfaceTexture consumes, so the session accepts it as a preview.
          previewReader =
            ImageReader.newInstance(size.width, size.height, ImageFormat.PRIVATE, 4, HardwareBuffer.USAGE_GPU_SAMPLED_IMAGE)
              .apply { setOnImageAvailableListener({ onPreviewFrame(it) }, handler) }
          outputs += OutputConfiguration(previewReader!!.surface)
        }
      }

      val config =
        ExtensionSessionConfiguration(
          ext,
          outputs,
          executor,
          object : CameraExtensionSession.StateCallback() {
            override fun onConfigured(s: CameraExtensionSession) {
              if (finished) return s.close()
              session = s
              mark("configured")
              if (withPreview) startPreview(camera, s) else handler.postDelayed({ capture() }, warmupMs)
            }

            override fun onConfigureFailed(s: CameraExtensionSession) {
              if (withPreview) {
                // Retry with the still output alone.
                withPreview = false
                previewSize = null
                previewReader?.close()
                previewReader = null
                stillReader?.close()
                stillReader = null
                configure(camera)
              } else {
                fail("CONFIGURE_FAILED", "The Night session couldn't be configured.")
              }
            }
          },
        )
      camera.createExtensionSession(config)
    } catch (e: Exception) {
      fail("CONFIGURE_FAILED", "${e.javaClass.simpleName}: ${e.message}")
    }
  }

  private fun startPreview(camera: CameraDevice, s: CameraExtensionSession) {
    try {
      val request =
        camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply {
          addTarget(previewReader!!.surface)
          set(CaptureRequest.CONTROL_ZOOM_RATIO, appliedZoom)
        }
      s.setRepeatingRequest(request.build(), executor, object : CameraExtensionSession.ExtensionCaptureCallback() {})
    } catch (e: Exception) {
      fail("PREVIEW_FAILED", "${e.javaClass.simpleName}: ${e.message}")
    }
  }

  private fun onPreviewFrame(reader: ImageReader) {
    reader.acquireLatestImage()?.close()
    if (previewSeen || finished) return
    previewSeen = true
    mark("firstPreview")
    handler.postDelayed({ capture() }, warmupMs)
  }

  private fun capture() {
    val s = session ?: return
    val camera = device ?: return
    if (captureRequested || finished) return
    captureRequested = true
    mark("captureRequested")
    try {
      val request =
        camera.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE).apply {
          addTarget(stillReader!!.surface)
          set(CaptureRequest.CONTROL_ZOOM_RATIO, appliedZoom)
          set(CaptureRequest.JPEG_QUALITY, JPEG_QUALITY)
        }
      s.capture(
        request.build(),
        executor,
        object : CameraExtensionSession.ExtensionCaptureCallback() {
          override fun onCaptureStarted(session: CameraExtensionSession, request: CaptureRequest, timestamp: Long) {
            mark("captureStarted")
          }

          override fun onCaptureProcessStarted(session: CameraExtensionSession, request: CaptureRequest) {
            mark("processStarted")
          }

          override fun onCaptureFailed(session: CameraExtensionSession, request: CaptureRequest) {
            fail("CAPTURE_FAILED", "The Night capture failed.")
          }
        },
      )
    } catch (e: Exception) {
      fail("CAPTURE_FAILED", "${e.javaClass.simpleName}: ${e.message}")
    }
  }

  private fun onStill(reader: ImageReader) {
    val image = reader.acquireLatestImage() ?: return
    if (finished) return image.close()
    mark("stillAvailable")
    try {
      val buffer = image.planes[0].buffer
      val bytes = ByteArray(buffer.remaining()).also { buffer.get(it) }
      output.writeBytes(bytes)
      val sensorOrientation = manager.getCameraCharacteristics(cameraId).get(CameraCharacteristics.SENSOR_ORIENTATION)
      succeed(
        mapOf(
          "uri" to Uri.fromFile(output).toString(),
          "width" to image.width,
          "height" to image.height,
          "bytes" to bytes.size,
          "sensorOrientation" to sensorOrientation,
          "zoomRatio" to appliedZoom.toDouble(),
          "preview" to withPreview,
          "previewSize" to previewSize?.let { mapOf("w" to it.width, "h" to it.height) },
          "warmupMs" to warmupMs,
          "openAttempts" to openAttempts,
          "timingsMs" to timings,
        ),
      )
    } catch (e: Exception) {
      fail("SAVE_FAILED", "${e.javaClass.simpleName}: ${e.message}")
    } finally {
      image.close()
    }
  }

  private fun succeed(result: Map<String, Any?>) {
    if (finished) return
    finished = true
    close()
    promise.resolve(result)
  }

  private fun fail(code: String, message: String) {
    if (finished) return
    finished = true
    close()
    promise.reject(code, message, null)
  }

  private fun close() {
    handler.removeCallbacksAndMessages(null)
    runCatching { session?.close() }
    runCatching { device?.close() }
    runCatching { stillReader?.close() }
    runCatching { previewReader?.close() }
    thread.quitSafely()
  }

  private companion object {
    const val TIMEOUT_MS = 20_000L
    const val MAX_OPEN_ATTEMPTS = 15
    const val OPEN_RETRY_MS = 200L
    const val JPEG_QUALITY: Byte = 95
  }
}
