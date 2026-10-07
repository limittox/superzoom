# Spec Delta

## MODIFIED Requirements

### Requirement: Upload preparation
The app SHALL upload a JPEG copy of the crop, keeping its aspect ratio: downscaled to at most 4 megapixels, or, for a crop whose short side is under the service's 128-pixel minimum, enlarged so the short side is 128 pixels. The full-resolution crop SHALL stay on the device and be used for the comparison and for saving the original.

#### Scenario: Large crop
- **WHEN** the captured crop is 12 megapixels
- **THEN** the uploaded image is at most 4 megapixels with the same aspect ratio, and the saved original is still 12 megapixels

#### Scenario: Small crop
- **WHEN** the captured crop is 1.5 megapixels
- **THEN** the uploaded image keeps its original dimensions

#### Scenario: Tiny crop from extreme zoom
- **WHEN** the captured crop is 95×204 pixels
- **THEN** the uploaded image is 128×275 pixels, and the saved original stays 95×204 pixels

### Requirement: AI-enhanced labeling
The app SHALL clearly label the enhanced image as AI-enhanced and SHALL show the mode used. In Creative mode it SHALL also note that some detail may be invented. For a capture beyond the native-pixel limit, it SHALL instead label the result AI-reconstructed, in every mode, and say that most detail was generated.

#### Scenario: Creative result
- **WHEN** a Creative-mode result is shown
- **THEN** the result is labeled AI-enhanced (Creative) with a note that some detail may not match reality

#### Scenario: Extreme-zoom result
- **WHEN** a result is shown for a capture taken beyond the native-pixel limit, in any mode
- **THEN** it is labeled AI-reconstructed with a note that most detail was generated and may not match reality
