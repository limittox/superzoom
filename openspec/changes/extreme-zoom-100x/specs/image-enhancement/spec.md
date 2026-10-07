# Spec Delta

## MODIFIED Requirements

### Requirement: Output size limit
The service SHALL choose an upscale factor of at least 2x and at most 10x per side, so the output never exceeds 16 megapixels and keeps the input's aspect ratio. For a model that accepts at most 4x per request, the service SHALL reach the factor with two passes.

#### Scenario: Small crop
- **WHEN** the input is 1000×1000 pixels
- **THEN** the output is larger than 2000×2000 pixels and at most 4000×4000 pixels

#### Scenario: Medium crop
- **WHEN** the input is 2000×1500 pixels
- **THEN** the output is at least 4000×3000 pixels, at most 16 MP, and has a 4:3 aspect ratio

#### Scenario: Tiny crop from extreme zoom
- **WHEN** the input is 94×204 pixels in Enhance mode
- **THEN** the output is upscaled 10x to about 940×2040 pixels in a single provider request

#### Scenario: Tiny crop in a mode capped at 4x
- **WHEN** the input is 94×204 pixels in Pro or Creative mode
- **THEN** the service runs two provider requests and returns an output of the same size as Enhance mode, within the overall timeout

## ADDED Requirements

### Requirement: Abandoned requests stop provider work
When the app cancels or disconnects before the response, or the request times out, the service SHALL stop processing it and SHALL ask the AI provider to cancel any of its jobs still queued, so abandoned requests don't occupy provider capacity or cost money.

#### Scenario: User cancels while enhancing
- **WHEN** the app cancels a request while the provider job is still queued
- **THEN** the service stops waiting, asks the provider to cancel that job, and starts no further passes

#### Scenario: Request times out
- **WHEN** a request reaches the 120-second timeout with a provider job still queued
- **THEN** the service responds with `timeout` and asks the provider to cancel that job
