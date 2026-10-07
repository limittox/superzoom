# Spec Delta

## MODIFIED Requirements

### Requirement: Output size limit
The service SHALL choose an upscale factor of at least 2x and at most 10x per side, so the output never exceeds 16 megapixels and keeps the input's aspect ratio. For a model that accepts at most 4x per request, the service SHALL reach the factor with two passes. Where a model limits the output for small inputs, the service SHALL lower the factor to fit: for Enhance, an input under 256 pixels on the short side produces at most 1920×1080 pixels (in either orientation).

#### Scenario: Small crop
- **WHEN** the input is 1000×1000 pixels
- **THEN** the output is larger than 2000×2000 pixels and at most 4000×4000 pixels

#### Scenario: Medium crop
- **WHEN** the input is 2000×1500 pixels
- **THEN** the output is at least 4000×3000 pixels, at most 16 MP, and has a 4:3 aspect ratio

#### Scenario: Tiny crop from extreme zoom
- **WHEN** the input is 128×275 pixels (a 100x crop enlarged by the app for upload) in Enhance mode
- **THEN** the output is upscaled about 7x to about 893×1920 pixels in a single provider request

#### Scenario: Tiny crop in a mode capped at 4x
- **WHEN** the input is 128×275 pixels in Pro or Creative mode
- **THEN** the service runs two provider requests and returns an output upscaled 10x to about 1280×2750 pixels, within the overall timeout

### Requirement: Input validation
The service SHALL accept only JPEG and PNG images no larger than 20 MB and at least 128 pixels on the shortest side, the smallest size every enhancement model accepts. Invalid input SHALL be rejected with a specific error before any AI provider is called.

#### Scenario: Unsupported format
- **WHEN** the app uploads a GIF
- **THEN** the service responds with an `unsupported_format` error

#### Scenario: Oversized upload
- **WHEN** the app uploads a 25 MB file
- **THEN** the service responds with a `file_too_large` error

#### Scenario: Image too small
- **WHEN** the app uploads a 50×50 pixel image
- **THEN** the service responds with an `image_too_small` error

#### Scenario: Tiny crop not enlarged
- **WHEN** an upload is 95×204 pixels
- **THEN** the service responds with an `image_too_small` error, since Enhance's model rejects images under 128 pixels per side

## ADDED Requirements

### Requirement: Abandoned requests stop provider work
When the app cancels or disconnects before the response, or the request times out, the service SHALL stop processing it and SHALL ask the AI provider to cancel any of its jobs still queued, so abandoned requests don't occupy provider capacity or cost money.

#### Scenario: User cancels while enhancing
- **WHEN** the app cancels a request while the provider job is still queued
- **THEN** the service stops waiting, asks the provider to cancel that job, and starts no further passes

#### Scenario: Request times out
- **WHEN** a request reaches the 120-second timeout with a provider job still queued
- **THEN** the service responds with `timeout` and asks the provider to cancel that job
