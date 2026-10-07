# image-enhancement Specification

## Purpose

Provides the backend service that turns a captured zoom crop into a sharper, higher-resolution image using a cloud AI upscaler, while keeping provider credentials off the device and keeping cost per request bounded.

## Requirements

### Requirement: Enhancement request
The service SHALL expose an HTTPS endpoint that accepts one image and an enhancement mode, and returns the enhanced image's download URL and its pixel dimensions. If no mode is given, the service SHALL use `enhance`.

#### Scenario: Successful enhancement
- **WHEN** the app sends a valid 2 MP JPEG with mode `enhance`
- **THEN** the service responds with success, a download URL for the enhanced image, and its width and height in pixels

#### Scenario: Mode omitted
- **WHEN** the app sends a valid image without a mode
- **THEN** the service processes it with the `enhance` mode

### Requirement: Enhancement modes
The service SHALL support exactly three modes: `enhance` (default; balanced quality, faithful to the input), `pro` (highest fidelity, higher cost) and `creative` (strongest sharpening, may invent detail). Any other mode value SHALL be rejected.

#### Scenario: Pro mode
- **WHEN** the app sends a valid image with mode `pro`
- **THEN** the service processes it with the high-fidelity model and responds with the result

#### Scenario: Unknown mode
- **WHEN** the app sends mode `ultra`
- **THEN** the service responds with an `invalid_mode` error and does not call any AI provider

### Requirement: Output size limit
The service SHALL choose an upscale factor of at least 2x and at most 10x per side, so the output never exceeds 16 megapixels and keeps the input's aspect ratio. For a model that accepts at most 4x per request, the service SHALL reach the factor with two passes. Where a model limits the output for small inputs, the service SHALL lower the factor to fit: for Enhance, an input under 256 pixels on the short side produces at most 1920×1080 pixels (in either orientation). An input that can't fit that limit even at 2x SHALL be rejected with an `image_too_small` error before the provider is called.

#### Scenario: Small crop
- **WHEN** the input is 1000×1000 pixels
- **THEN** the output is larger than 2000×2000 pixels and at most 4000×4000 pixels

#### Scenario: Medium crop
- **WHEN** the input is 2000×1500 pixels
- **THEN** the output is at least 4000×3000 pixels, at most 16 MP, and has a 4:3 aspect ratio

#### Scenario: Tiny crop from extreme zoom
- **WHEN** the input is 128×275 pixels (a 100x crop enlarged by the app for upload) in Enhance mode
- **THEN** the output is upscaled about 7x to about 893×1920 pixels in a single provider request

#### Scenario: Narrow input beyond the Enhance limit
- **WHEN** the input is 255×5000 pixels in Enhance mode
- **THEN** the service responds with an `image_too_small` error without calling the provider, since even 2x (510×10000) exceeds 1920×1080

#### Scenario: Tiny crop in a mode capped at 4x
- **WHEN** the input is 128×275 pixels in Pro or Creative mode
- **THEN** the service runs two provider requests and returns an output upscaled 10x to about 1280×2750 pixels, within the overall timeout

### Requirement: Input pixel limit
The service SHALL reject inputs larger than 4 megapixels with an `image_too_large` error, so a 2x upscale always fits within the output limit.

#### Scenario: Large crop
- **WHEN** the input is 4000×3000 pixels
- **THEN** the service responds with an `image_too_large` error and does not call any AI provider

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

### Requirement: Credentials stay server-side
The AI provider's API key SHALL exist only on the server. It SHALL NOT be included in the app bundle, in any response, or in any error message.

#### Scenario: Inspecting the app
- **WHEN** someone inspects the built app bundle or its network traffic
- **THEN** no AI provider API key is present

### Requirement: Per-device rate limit
The service SHALL limit how many enhancements each app installation can request per rolling 24 hours (configurable on the server, default 50). Requests over the limit SHALL be rejected with an error that says when the user can try again.

#### Scenario: Limit exceeded
- **WHEN** an installation that already made 50 requests in the last 24 hours sends another
- **THEN** the service responds with a `rate_limited` error that includes the retry time, and does not call any AI provider

### Requirement: Structured errors
Every failure SHALL return a machine-readable error code and a short human-readable message. Provider failures and timeouts SHALL be reported as `provider_error` and `timeout`, without exposing provider internals.

#### Scenario: Provider failure
- **WHEN** the AI provider returns an error
- **THEN** the service responds with a `provider_error` code and a generic message

#### Scenario: Slow provider
- **WHEN** the AI provider has not finished within 120 seconds
- **THEN** the service responds with a `timeout` error

### Requirement: No image retention by the service
The service SHALL NOT store uploaded or enhanced images beyond what the request needs. Images SHALL NOT be written to logs.

#### Scenario: After a request completes
- **WHEN** an enhancement request has finished, successfully or not
- **THEN** the service itself holds no copy of the uploaded or enhanced image

### Requirement: Abandoned requests stop provider work
When the app cancels or disconnects before the response, or the request times out, the service SHALL stop processing it and SHALL ask the AI provider to cancel any of its jobs still queued, so abandoned requests don't occupy provider capacity or cost money.

#### Scenario: User cancels while enhancing
- **WHEN** the app cancels a request while the provider job is still queued
- **THEN** the service stops waiting, asks the provider to cancel that job, and starts no further passes

#### Scenario: Request times out
- **WHEN** a request reaches the 120-second timeout with a provider job still queued
- **THEN** the service responds with `timeout` and asks the provider to cancel that job
