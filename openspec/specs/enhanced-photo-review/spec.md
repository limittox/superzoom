# enhanced-photo-review Specification

## Purpose

Lets users send a captured zoom crop for AI enhancement, follow its progress, compare the result with the original, and save the images they want to the device gallery.

## Requirements

### Requirement: Mode selection
The app SHALL let the user choose an enhancement mode (Enhance, Pro, Creative) on the camera screen and on the result screen, with a one-line description of each. Enhance SHALL be selected by default, and the choice SHALL persist across app launches.

#### Scenario: Default mode
- **WHEN** a user who has never changed the mode captures a photo
- **THEN** the photo is enhanced with Enhance

#### Scenario: Mode remembered
- **WHEN** the user picks Creative, closes the app and opens it again
- **THEN** Creative is still selected

### Requirement: Cloud processing disclosure
Before the first enhancement, the app SHALL tell the user that photos are sent to a cloud AI service for processing and SHALL ask for consent. Without consent, the app SHALL NOT upload any image.

#### Scenario: First capture
- **WHEN** the user captures a photo for the first time
- **THEN** the app shows the cloud processing notice before uploading anything

#### Scenario: Consent declined
- **WHEN** the user declines the notice
- **THEN** no image is uploaded, and the user can still view and save the original crop

### Requirement: Automatic enhancement after capture
After capture, the app SHALL show the original crop immediately and start enhancing it in the selected mode. While waiting, the app SHALL show a progress state and let the user cancel.

#### Scenario: Waiting for the result
- **WHEN** the user captures a photo and consent has been given
- **THEN** the result screen shows the original crop with a progress indicator while the enhancement runs

#### Scenario: Cancel
- **WHEN** the user cancels while enhancement is in progress
- **THEN** the app stops waiting, discards any late result, and keeps the original crop available

### Requirement: Upload preparation
The app SHALL upload a JPEG copy of the crop downscaled to at most 4 megapixels, keeping its aspect ratio. The full-resolution crop SHALL stay on the device and be used for the comparison and for saving the original.

#### Scenario: Large crop
- **WHEN** the captured crop is 12 megapixels
- **THEN** the uploaded image is at most 4 megapixels with the same aspect ratio, and the saved original is still 12 megapixels

#### Scenario: Small crop
- **WHEN** the captured crop is 1.5 megapixels
- **THEN** the uploaded image keeps its original dimensions

### Requirement: Before/after comparison
When the enhanced image is ready, the app SHALL show the original and enhanced images aligned at the same framing, with a draggable divider that reveals one on each side. The user SHALL be able to pinch-zoom and pan, and both images SHALL stay aligned.

#### Scenario: Drag the divider
- **WHEN** the user drags the divider to the right
- **THEN** more of the original image and less of the enhanced image is shown, both at the same position and scale

#### Scenario: Zoom into the comparison
- **WHEN** the user pinch-zooms on the comparison
- **THEN** both images zoom and pan together

### Requirement: AI-enhanced labeling
The app SHALL clearly label the enhanced image as AI-enhanced and SHALL show the mode used. In Creative mode it SHALL also note that some detail may be invented.

#### Scenario: Creative result
- **WHEN** a Creative-mode result is shown
- **THEN** the result is labeled AI-enhanced (Creative) with a note that some detail may not match reality

### Requirement: Retry and switch mode
The app SHALL let the user re-run enhancement on the same crop in any mode without capturing again. When enhancement fails, the app SHALL show a clear message for the error and a retry action.

#### Scenario: Try another mode
- **WHEN** the user picks Pro on the result screen for a crop already enhanced with Enhance
- **THEN** the same crop is enhanced again with Pro and the comparison updates to the new result

#### Scenario: Network failure
- **WHEN** the device is offline during enhancement
- **THEN** the app says the enhancement could not reach the server and offers Retry

#### Scenario: Rate limited
- **WHEN** the service responds that the device's daily limit has been reached
- **THEN** the app tells the user when they can enhance again and still allows saving the original

### Requirement: Save to gallery
The app SHALL let the user save the enhanced image, the original crop, or both to the device photo gallery at full resolution. It SHALL ask for photo-library permission when first needed and confirm when saving succeeds.

#### Scenario: Save both
- **WHEN** the user chooses to save both images and permission is granted
- **THEN** both images appear in the device gallery at full resolution and the app confirms the save

#### Scenario: Gallery permission denied
- **WHEN** the user denies photo-library permission
- **THEN** nothing is saved, and the app explains why and offers to open system settings

### Requirement: Return to camera
The user SHALL be able to go back from the result screen to the camera, with the previous zoom level kept. Unsaved images from that session SHALL be discarded after the user confirms.

#### Scenario: Leave without saving
- **WHEN** the user goes back to the camera without saving the enhanced image
- **THEN** the app asks for confirmation before discarding it, and after confirmation the camera returns at the previous zoom level
