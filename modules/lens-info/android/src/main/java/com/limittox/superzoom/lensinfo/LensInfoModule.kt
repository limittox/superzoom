package com.limittox.superzoom.lensinfo

import android.content.Context
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraExtensionCharacteristics
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CameraMetadata
import android.hardware.camera2.params.StreamConfigurationMap
import android.os.Build
import android.util.Size
import java.io.File
import expo.modules.kotlin.Promise
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

    AsyncFunction("getSensorModes") {
      readSensorModes()
    }

    // Development only: one photo through the Night extension (see NightCapture).
    AsyncFunction("captureNight") { cameraId: String, zoomRatio: Double, warmupMs: Int, promise: Promise ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
        promise.reject("UNSUPPORTED", "Camera extensions need Android 12 or later.", null)
        return@AsyncFunction
      }
      val output = File(context.cacheDir, "night-${System.currentTimeMillis()}.jpg")
      NightCapture(context, cameraId, zoomRatio.toFloat(), warmupMs.toLong(), output).run(promise)
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
   * Each field is null where the OS is too old to report it. Null overall on API < 31. On failure,
   * `error` names the step that failed and the exception, so a device that refuses the query says why.
   */
  private fun readExtensionInfo(cameraId: String): Map<String, Any?>? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return null
    var step = "getCameraExtensionCharacteristics"
    return try {
      val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
      val extensions = manager.getCameraExtensionCharacteristics(cameraId)
      step = "supportedExtensions"
      val supported = extensions.supportedExtensions
      step = "describeExtension"
      val details = supported.map { ext -> describeExtension(extensions, ext) }
      mapOf("sdkInt" to Build.VERSION.SDK_INT, "extensions" to details, "error" to null)
    } catch (e: Throwable) {
      mapOf(
        "sdkInt" to Build.VERSION.SDK_INT,
        "extensions" to emptyList<Any>(),
        "error" to "$step: ${e.javaClass.name}: ${e.message}",
      )
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

  /**
   * Which output sizes every camera (and each physical lens behind a logical camera) offers apps,
   * including the full-resolution ("maximum resolution", Android 12+) sensor mode that a 50 MP
   * pixel-binned sensor needs for unbinned photos. Fields are null where the OS is too old to report
   * them. On failure, `error` names the camera and the exception.
   */
  private fun readSensorModes(): Map<String, Any?> {
    val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
    val cameras = mutableListOf<Map<String, Any?>>()
    val seen = mutableSetOf<String>()
    val errors = mutableListOf<String>()
    fun visit(id: String, parent: String?) {
      if (!seen.add(id)) return
      try {
        val chars = manager.getCameraCharacteristics(id)
        cameras += describeSensorModes(id, parent, chars)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) chars.physicalCameraIds.forEach { visit(it, id) }
      } catch (e: Throwable) {
        errors += "$id: ${e.javaClass.name}: ${e.message}"
      }
    }
    try {
      manager.cameraIdList.forEach { visit(it, null) }
    } catch (e: Throwable) {
      errors += "cameraIdList: ${e.javaClass.name}: ${e.message}"
    }
    return mapOf(
      "sdkInt" to Build.VERSION.SDK_INT,
      "cameras" to cameras,
      "error" to errors.takeIf { it.isNotEmpty() }?.joinToString("; "),
    )
  }

  private fun describeSensorModes(id: String, parent: String?, chars: CameraCharacteristics): Map<String, Any?> {
    val caps = chars.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES)?.toSet() ?: emptySet()
    val s = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
    val maxResMap: StreamConfigurationMap? =
      if (s) {
        runCatching { chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP_MAXIMUM_RESOLUTION) }.getOrNull()
      } else {
        null
      }
    return mapOf(
      "id" to id,
      "parent" to parent,
      "facing" to
        when (chars.get(CameraCharacteristics.LENS_FACING)) {
          CameraMetadata.LENS_FACING_BACK -> "back"
          CameraMetadata.LENS_FACING_FRONT -> "front"
          else -> "external"
        },
      "focalLength" to chars.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)?.firstOrNull()?.toDouble(),
      "pixelArray" to chars.get(CameraCharacteristics.SENSOR_INFO_PIXEL_ARRAY_SIZE)?.let(::sizeMap),
      "logicalMultiCamera" to (CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_LOGICAL_MULTI_CAMERA in caps),
      "raw" to (CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_RAW in caps),
      "ultraHighResolution" to
        if (s) CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_ULTRA_HIGH_RESOLUTION_SENSOR in caps else null,
      "remosaicReprocessing" to
        if (s) CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_REMOSAIC_REPROCESSING in caps else null,
      "pixelArrayMaxRes" to
        if (s) chars.get(CameraCharacteristics.SENSOR_INFO_PIXEL_ARRAY_SIZE_MAXIMUM_RESOLUTION)?.let(::sizeMap) else null,
      "binningFactor" to if (s) chars.get(CameraCharacteristics.SENSOR_INFO_BINNING_FACTOR)?.let(::sizeMap) else null,
      // Whether a capture request may set SENSOR_PIXEL_MODE (default vs maximum resolution).
      "pixelModeRequestKey" to
        if (s) chars.availableCaptureRequestKeys.any { it.name == CaptureRequest.SENSOR_PIXEL_MODE.name } else null,
      "default" to describeStreams(chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)),
      "maxRes" to maxResMap?.let(::describeStreams),
    )
  }

  /** Largest regular and "high resolution" (slower, burst-incapable) size per format. */
  private fun describeStreams(map: StreamConfigurationMap?): Map<String, Any?>? {
    map ?: return null
    fun largest(sizes: Array<Size>?): Map<String, Int>? =
      sizes?.maxByOrNull { it.width.toLong() * it.height }?.let(::sizeMap)
    val formats = mapOf("jpeg" to ImageFormat.JPEG, "yuv" to ImageFormat.YUV_420_888, "raw" to ImageFormat.RAW_SENSOR)
    return formats.mapValues { (_, format) ->
      mapOf(
        "largest" to largest(runCatching { map.getOutputSizes(format) }.getOrNull()),
        "highRes" to largest(runCatching { map.getHighResolutionOutputSizes(format) }.getOrNull()),
      )
    }
  }

  private fun sizeMap(size: Size): Map<String, Int> = mapOf("w" to size.width, "h" to size.height)

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
