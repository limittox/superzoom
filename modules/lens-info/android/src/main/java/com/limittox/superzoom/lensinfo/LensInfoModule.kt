package com.limittox.superzoom.lensinfo

import android.content.Context
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraExtensionCharacteristics
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.CameraManager
import android.os.Build
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Reports the raw geometry of the lenses behind a logical (multi-lens) camera, so the app
 * can compute each lens's zoom factor. VisionCamera 5.2.3 doesn't expose lens switch points
 * on Android. The zoom factor math lives in TypeScript (src/camera/lensGeometry.ts).
 */
class LensInfoModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LensInfo")

    AsyncFunction("getLensGeometry") { cameraId: String ->
      readGeometry(cameraId)
    }

    AsyncFunction("getExtensionInfo") { cameraId: String ->
      readExtensionInfo(cameraId)
    }
  }

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  /** Null for a camera that isn't a logical multi-camera, on API < 28, or on any error. */
  private fun readGeometry(cameraId: String): Map<String, Any?>? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return null
    return try {
      val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
      val logical = manager.getCameraCharacteristics(cameraId)
      val physicalIds = logical.physicalCameraIds
      if (physicalIds.size < 2) return null

      // Android defines CONTROL_ZOOM_RATIO = 1.0 relative to the logical camera, so it is the reference.
      val reference = describeLens(cameraId, logical) ?: return null
      val lenses = physicalIds.mapNotNull { id -> describeLens(id, manager.getCameraCharacteristics(id)) }
      val zoomRatioRange =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
          logical.get(CameraCharacteristics.CONTROL_ZOOM_RATIO_RANGE)?.let {
            listOf(it.lower.toDouble(), it.upper.toDouble())
          }
        } else {
          null
        }

      mapOf("reference" to reference, "lenses" to lenses, "zoomRatioRange" to zoomRatioRange)
    } catch (e: Exception) {
      null
    }
  }

  private fun describeLens(id: String, characteristics: CameraCharacteristics): Map<String, Any>? {
    val focalLength =
      characteristics.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)?.firstOrNull() ?: return null
    val physicalSize = characteristics.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE) ?: return null
    val pixelArray = characteristics.get(CameraCharacteristics.SENSOR_INFO_PIXEL_ARRAY_SIZE) ?: return null
    val activeArray = characteristics.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE) ?: return null
    return mapOf(
      "id" to id,
      "focalLength" to focalLength.toDouble(),
      "physicalSize" to mapOf("w" to physicalSize.width.toDouble(), "h" to physicalSize.height.toDouble()),
      "pixelArray" to mapOf("w" to pixelArray.width, "h" to pixelArray.height),
      "activeArray" to mapOf("w" to activeArray.width(), "h" to activeArray.height()),
    )
  }

  /**
   * What Camera2 vendor extensions (Night, HDR, …) support on this camera: request keys
   * (e.g. whether zoom works), zoom range, largest JPEG size and capture latency.
   * Each field is null where the OS is too old to report it. Null overall on API < 31 or on error.
   */
  private fun readExtensionInfo(cameraId: String): Map<String, Any?>? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return null
    return try {
      val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
      val extensions = manager.getCameraExtensionCharacteristics(cameraId)
      val details = extensions.supportedExtensions.map { ext -> describeExtension(extensions, ext) }
      mapOf("sdkInt" to Build.VERSION.SDK_INT, "extensions" to details)
    } catch (e: Exception) {
      null
    }
  }

  private fun describeExtension(chars: CameraExtensionCharacteristics, ext: Int): Map<String, Any?> {
    val jpegSizes = runCatching { chars.getExtensionSupportedSizes(ext, ImageFormat.JPEG) }.getOrDefault(emptyList())
    val largest = jpegSizes.maxByOrNull { it.width.toLong() * it.height }

    // API 33+: which capture request keys the extension honours (CONTROL_ZOOM_RATIO = zoom works).
    val requestKeys: List<String>? =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        runCatching { chars.getAvailableCaptureRequestKeys(ext).map { it.name } }.getOrNull()
      } else {
        null
      }

    // API 35+: the extension's own zoom ratio range (it can be narrower than the camera's).
    val zoomRatioRange: List<Double>? =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) {
        runCatching {
          chars.get(ext, CameraCharacteristics.CONTROL_ZOOM_RATIO_RANGE)?.let {
            listOf(it.lower.toDouble(), it.upper.toDouble())
          }
        }.getOrNull()
      } else {
        null
      }

    val latencyMs: List<Long>? =
      largest?.let { size ->
        runCatching {
          chars.getEstimatedCaptureLatencyRangeMillis(ext, size, ImageFormat.JPEG)?.let { listOf(it.lower, it.upper) }
        }.getOrNull()
      }

    return mapOf(
      "type" to extensionName(ext),
      "supportsZoom" to requestKeys?.contains(CaptureRequest.CONTROL_ZOOM_RATIO.name),
      "requestKeys" to requestKeys,
      "zoomRatioRange" to zoomRatioRange,
      "maxJpegSize" to largest?.let { mapOf("w" to it.width, "h" to it.height) },
      "captureLatencyMs" to latencyMs,
    )
  }

  private fun extensionName(ext: Int): String =
    when (ext) {
      CameraExtensionCharacteristics.EXTENSION_AUTOMATIC -> "auto"
      CameraExtensionCharacteristics.EXTENSION_FACE_RETOUCH -> "face-retouch"
      CameraExtensionCharacteristics.EXTENSION_BOKEH -> "bokeh"
      CameraExtensionCharacteristics.EXTENSION_HDR -> "hdr"
      CameraExtensionCharacteristics.EXTENSION_NIGHT -> "night"
      else -> "unknown-$ext"
    }
}
