# Spec Delta

## ADDED Requirements

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
