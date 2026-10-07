# Spec Delta

## MODIFIED Requirements

### Requirement: Automatic enhancement after capture
After capture, the app SHALL show the original crop immediately and start enhancing it in the selected mode. While waiting, the app SHALL show a progress state that says whether the job is queued, enhancing or finishing a second pass, and SHALL let the user cancel. Cancelling, including leaving the result screen, SHALL cancel the job on the service.

#### Scenario: Waiting for the result
- **WHEN** the user captures a photo and consent has been given
- **THEN** the result screen shows the original crop with a progress indicator and the job's current phase while the enhancement runs

#### Scenario: Cancel
- **WHEN** the user cancels while enhancement is in progress
- **THEN** the app stops waiting, asks the service to cancel the job, discards any late result, and keeps the original crop available

#### Scenario: Leave the result screen
- **WHEN** the user goes back to the camera while enhancement is in progress
- **THEN** the app asks the service to cancel the job

## ADDED Requirements

### Requirement: Enhancement survives switching apps
Switching to another app or locking the phone during an enhancement SHALL NOT cancel it. While the app is in the background it SHALL stop polling. When it returns, it SHALL resume the same job without uploading the crop again and show the result once it's ready. A job that finished while the app was away SHALL be shown right away.

#### Scenario: Result finished while away
- **WHEN** the user switches to another app during an enhancement and comes back after it has finished
- **THEN** the result screen shows the enhanced image without a new upload or a new enhancement

#### Scenario: Back before it finishes
- **WHEN** the user comes back while the job is still running
- **THEN** the progress state resumes and the result appears when the job finishes

#### Scenario: Submission interrupted
- **WHEN** the app goes to the background while the crop is still uploading and the upload fails
- **THEN** on return the app resubmits the same request, and the service treats it as the same job

#### Scenario: Server unreachable on return
- **WHEN** the app returns but can't reach the service for 30 seconds
- **THEN** the app says it could not reach the server and offers Retry, which resumes the same job rather than starting a new one
