# zoom-capture Specification

## Purpose

Lets users frame distant subjects with the rear camera, zooming smoothly through the device's optical lenses and beyond, and capture a photo of the framed region at native sensor resolution for later AI enhancement.

## Requirements

### Requirement: Camera permission
The app SHALL request camera permission before showing the camera preview. If the user denies it, the app SHALL show an explanation and a way to open the system settings, and SHALL NOT show a blank or frozen preview.

#### Scenario: First launch grants permission
- **WHEN** the user opens the app for the first time and grants camera permission
- **THEN** the live rear-camera preview is shown

#### Scenario: Permission denied
- **WHEN** the user has denied camera permission
- **THEN** the app shows a message explaining that the camera is required, with a button that opens the app's system settings

### Requirement: Live rear-camera preview
The app SHALL show a full-screen live preview from the rear camera, using a device configuration that spans every rear physical lens the device exposes (for example ultra-wide, wide and telephoto).

#### Scenario: Multi-lens device
- **WHEN** the app runs on a device with ultra-wide, wide and telephoto rear lenses
- **THEN** the preview starts at 1x and every lens is reachable through zoom without restarting the preview

#### Scenario: Single-lens device
- **WHEN** the app runs on a device with only one rear lens
- **THEN** the preview starts at 1x and zoom beyond the optical range still works using the digital crop

### Requirement: Pinch-to-zoom
The app SHALL change the zoom level continuously as the user pinches on the preview, between the device's minimum zoom and the app's maximum zoom. The zoom SHALL follow the gesture without visible stutter.

#### Scenario: Pinch out
- **WHEN** the user pinches outward on the preview
- **THEN** the zoom level increases in proportion to the gesture, up to the maximum zoom

#### Scenario: Pinch at the limit
- **WHEN** the zoom is already at the maximum and the user keeps pinching outward
- **THEN** the zoom stays at the maximum

### Requirement: Zoom presets
The app SHALL show preset buttons for the zoom factor of each physical lens (for example 0.5x, 1x, 3x) plus at least one preset beyond the optical range. Tapping a preset SHALL animate the zoom to that factor.

#### Scenario: Tap telephoto preset
- **WHEN** the user taps the preset matching the telephoto lens
- **THEN** the zoom animates to that factor and the telephoto lens provides the preview

### Requirement: Seamless lens switching
When the zoom crosses the zoom factor of another physical lens, the device SHALL switch to that lens without interrupting the preview or resetting the zoom level.

#### Scenario: Zooming past the telephoto threshold
- **WHEN** the user pinches from 2x to 4x on a device with a 3x telephoto lens
- **THEN** the preview continues without a black frame or restart and is served by the telephoto lens from 3x onward

### Requirement: Zoom beyond the optical range
Beyond the longest lens's native zoom factor, the app SHALL continue zooming by digitally cropping the preview. Hardware zoom SHALL stay at the longest lens's native factor, so the captured photo holds that lens's native pixels and no hardware-interpolated pixels.

#### Scenario: Zoom past optical
- **WHEN** the user zooms to 10x on a device whose longest lens is 3x
- **THEN** the preview shows a 10x framing, and the captured photo is taken at 3x hardware zoom and then cropped to the 10x framing

### Requirement: Maximum zoom bound by native pixels
The app SHALL limit the maximum zoom so that the captured crop always contains at least 1 megapixel of native sensor pixels. The maximum therefore depends on the device's sensor resolution and longest lens.

#### Scenario: Maximum reached
- **WHEN** the user zooms to the app's maximum on any supported device
- **THEN** a capture at that zoom produces a crop of at least 1 megapixel

### Requirement: Zoom level indicator
The app SHALL always show the current zoom factor. It SHALL also show, in a visually distinct way, whether the zoom is within the optical range or beyond it (where AI enhancement does most of the work).

#### Scenario: Entering the beyond-optical range
- **WHEN** the zoom passes the longest lens's native factor
- **THEN** the indicator changes to show that the zoom is beyond the optical range

### Requirement: Tap to focus
The app SHALL focus and meter on the point the user taps on the preview, where the active lens supports it.

#### Scenario: Tap a subject
- **WHEN** the user taps a point on the preview
- **THEN** the camera focuses on that point and a focus indicator is shown briefly

### Requirement: Capture crops to the framed region
When the user presses the shutter, the app SHALL take a full-resolution photo from the active lens and crop it to exactly the region shown in the preview at the current zoom. The crop SHALL keep the photo's correct orientation and SHALL NOT be resized.

#### Scenario: Capture at digital zoom
- **WHEN** the user captures at 8x on a device whose longest lens is 3x
- **THEN** the result is the central region of the 3x photo, matching the 8x framing in the preview, at native pixel resolution

#### Scenario: Capture within the optical range
- **WHEN** the user captures at exactly a physical lens's native factor
- **THEN** the result is that lens's full photo, with no crop beyond aspect-ratio matching

#### Scenario: Device rotated
- **WHEN** the user captures while holding the phone in landscape
- **THEN** the cropped image is oriented upright as the user framed it

### Requirement: Shutter feedback
The app SHALL give immediate feedback when the shutter is pressed and SHALL prevent another capture until the current one has finished.

#### Scenario: Double tap on shutter
- **WHEN** the user taps the shutter twice in quick succession
- **THEN** exactly one photo is captured

### Requirement: Multi-lens rear camera selection
When a device exposes several rear cameras, the app SHALL use the one that spans the most physical lenses, even if the camera system does not report those lenses' types. It SHALL NOT pick a single-lens camera when a multi-lens camera covering it is available, and SHALL ignore depth-only cameras.

#### Scenario: Samsung logical quad camera
- **WHEN** a phone exposes a "Back Quad Camera" spanning four lenses of unreported type, plus a standalone ultra-wide camera
- **THEN** the app uses the quad camera, and 1x is the main lens

#### Scenario: iPhone triple camera
- **WHEN** an iPhone exposes standalone wide, ultra-wide and telephoto cameras plus dual and triple virtual cameras
- **THEN** the app uses the triple camera

### Requirement: Telephoto lenses on Android
On Android, when the zoom factors of the lenses behind the active rear camera can be determined, the app SHALL treat the longest lens's factor as the optical range: hardware zoom SHALL reach it, and digital cropping SHALL apply only beyond it. The optical range SHALL NOT exceed the camera's reported maximum zoom.

#### Scenario: Phone with 3x and 5x telephoto lenses
- **WHEN** the active rear camera includes lenses at 0.6x, 1x, 3x and 5x and the user zooms to 5x
- **THEN** the zoom indicator shows 5x as within the optical range, and the capture is taken at 5x hardware zoom without a digital crop

#### Scenario: Zoom past the longest telephoto
- **WHEN** the user zooms to 12x on that phone
- **THEN** hardware zoom stays at 5x and the capture is center-cropped to the 12x framing

#### Scenario: Lens beyond the camera's maximum
- **WHEN** a lens's factor is greater than the camera's reported maximum zoom
- **THEN** that lens is not offered as a preset, and the optical range ends at the longest lens within the maximum

### Requirement: Lens presets at true zoom factors
The app SHALL derive each lens's zoom factor from its field of view relative to the main lens (taking sensor size into account, not focal length alone), and SHALL label presets with that factor, rounded to a common value when within 10%.

#### Scenario: Small telephoto sensor
- **WHEN** a telephoto lens has a focal length 3 times the main lens's but a sensor with a 5 times narrower field of view
- **THEN** its preset is labeled 5x, not 3x

### Requirement: Fallback when lens factors are unknown
When the lens factors cannot be determined, for example on a phone without a multi-lens camera, or when the native lens query fails, the app SHALL keep the main lens as the optical range on Android and SHALL keep working with digital zoom beyond it.

#### Scenario: Lens query unavailable
- **WHEN** the lens factor query returns nothing or fails
- **THEN** the optical range ends at 1x, presets show the ultra-wide (if any) and 1x plus beyond-optical presets, and capture still works
