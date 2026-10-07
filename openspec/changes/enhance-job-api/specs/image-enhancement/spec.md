# Spec Delta

## MODIFIED Requirements

### Requirement: Enhancement request
The service SHALL expose an HTTPS endpoint that accepts one image, an enhancement mode and a client request ID, and starts an enhancement job. It SHALL respond with the job's ID as soon as the job is queued, without waiting for the enhanced image. If no mode is given, the service SHALL use `enhance`.

#### Scenario: Successful enhancement
- **WHEN** the app sends a valid 2 MP JPEG with mode `enhance`
- **THEN** the service responds within a few seconds with success and a job ID, the job is queued with the AI provider, and the job later reports the enhanced image's download URL, width and height

#### Scenario: Mode omitted
- **WHEN** the app sends a valid image without a mode
- **THEN** the job processes it with the `enhance` mode

#### Scenario: Invalid upload
- **WHEN** the app sends an invalid image, an unknown mode or no client request ID
- **THEN** the service responds with the matching error and creates no job

### Requirement: Structured errors
Every failure SHALL return a machine-readable error code and a short human-readable message, either as the response to a request or as the error of a failed job. Provider failures and timeouts SHALL be reported as `provider_error` and `timeout`, without exposing provider internals.

#### Scenario: Provider failure
- **WHEN** the AI provider fails a job
- **THEN** the job's status reports a `provider_error` code and a generic message

#### Scenario: Slow provider
- **WHEN** a provider pass has not finished within 120 seconds of being queued
- **THEN** the job's status reports a `timeout` error

### Requirement: Abandoned requests stop provider work
When the app cancels a job, or a provider pass times out, the service SHALL stop the job and SHALL ask the AI provider to cancel any of its work still queued, so abandoned jobs don't occupy provider capacity or cost money. A dropped connection or the app going to the background SHALL NOT cancel a job.

#### Scenario: User cancels while enhancing
- **WHEN** the app cancels a job while its provider work is still queued
- **THEN** the service marks the job cancelled, asks the provider to cancel that work, and starts no further passes

#### Scenario: Request times out
- **WHEN** a pass reaches the 120-second timeout with its provider work still queued
- **THEN** the job reports `timeout` and the service asks the provider to cancel that work

#### Scenario: App disconnects
- **WHEN** the app's connection drops or the app goes to the background while a job is running
- **THEN** the job keeps running and its result is available when the app asks for it

#### Scenario: Cancelled before the job ID arrived
- **WHEN** the app cancels a submission by its client request ID because the response with the job ID was lost
- **THEN** the service cancels that submission's job if it exists, and otherwise starts no job for that request ID

## ADDED Requirements

### Requirement: Job status and result
The service SHALL expose the state of each job: queued, processing, done, failed or cancelled. A done job SHALL include the enhanced image's download URL, its width and height in pixels, and the mode. A failed job SHALL include its error. The service SHALL carry a job through all of its provider passes without the app sending the image again.

#### Scenario: Job finished
- **WHEN** the app asks for the status of a job whose enhancement has finished
- **THEN** the service responds that it is done, with the download URL, width, height and mode

#### Scenario: Two-pass job
- **WHEN** a Pro or Creative job needs two passes and the app keeps asking for its status
- **THEN** the job moves from queued through processing to done, and reports which pass is running while it processes

#### Scenario: App returns after a long absence
- **WHEN** the app asks for a job's status for the first time in five minutes, after its first pass has finished
- **THEN** the service continues the job, starting any remaining pass, rather than failing it

### Requirement: Job ownership and expiry
A job SHALL be readable and cancellable only with the app installation ID that created it. Jobs SHALL expire one hour after they are created. Asking for an unknown, expired or other installation's job SHALL return a `job_not_found` error. Job records SHALL hold no image data.

#### Scenario: Another installation's job
- **WHEN** an installation asks for the status of a job another installation created
- **THEN** the service responds with `job_not_found` and reveals nothing about the job

#### Scenario: Expired job
- **WHEN** the app asks for a job created more than an hour ago
- **THEN** the service responds with `job_not_found`

### Requirement: Idempotent submission
Submitting again with the same installation ID and client request ID within an hour SHALL return the existing job instead of starting a new one, and SHALL NOT count again against the rate limit.

#### Scenario: Response lost during submission
- **WHEN** the app sends a submission, loses the response, and sends it again with the same client request ID
- **THEN** the service returns the same job ID, runs the enhancement once, and counts one request against the daily limit
