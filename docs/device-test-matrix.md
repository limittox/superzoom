# Device test matrix

Results for task 6.1 of `openspec/changes/add-zoom-camera-mvp`. Fill in one column per device with ✅, ❌ (link the follow-up issue) or n/a. Generated from the spec scenarios, so every scenario has a row.

Devices: **A** = iPhone with telephoto, **B** = iPhone without telephoto, **C** = Pixel, **D** = Samsung.

| Capability | Requirement | Scenario | A | B | C | D | Notes |
|---|---|---|---|---|---|---|---|
| zoom-capture | Camera permission | First launch grants permission |  |  |  |  |  |
| zoom-capture | Camera permission | Permission denied |  |  |  |  |  |
| zoom-capture | Live rear-camera preview | Multi-lens device |  |  |  |  |  |
| zoom-capture | Live rear-camera preview | Single-lens device |  |  |  |  |  |
| zoom-capture | Pinch-to-zoom | Pinch out |  |  |  |  |  |
| zoom-capture | Pinch-to-zoom | Pinch at the limit |  |  |  |  |  |
| zoom-capture | Zoom presets | Tap telephoto preset |  |  |  |  |  |
| zoom-capture | Seamless lens switching | Zooming past the telephoto threshold |  |  |  |  |  |
| zoom-capture | Zoom beyond the optical range | Zoom past optical |  |  |  |  |  |
| zoom-capture | Maximum zoom bound by native pixels | Maximum reached |  |  |  |  |  |
| zoom-capture | Zoom level indicator | Entering the beyond-optical range |  |  |  |  |  |
| zoom-capture | Tap to focus | Tap a subject |  |  |  |  |  |
| zoom-capture | Capture crops to the framed region | Capture at digital zoom |  |  |  |  |  |
| zoom-capture | Capture crops to the framed region | Capture within the optical range |  |  |  |  |  |
| zoom-capture | Capture crops to the framed region | Device rotated |  |  |  |  |  |
| zoom-capture | Shutter feedback | Double tap on shutter |  |  |  |  |  |
| image-enhancement | Enhancement request | Successful enhancement |  |  |  |  |  |
| image-enhancement | Enhancement request | Mode omitted |  |  |  |  |  |
| image-enhancement | Enhancement modes | Pro mode |  |  |  |  |  |
| image-enhancement | Enhancement modes | Unknown mode |  |  |  |  |  |
| image-enhancement | Output size limit | Small crop |  |  |  |  |  |
| image-enhancement | Output size limit | Medium crop |  |  |  |  |  |
| image-enhancement | Input pixel limit | Large crop |  |  |  |  |  |
| image-enhancement | Input validation | Unsupported format |  |  |  |  |  |
| image-enhancement | Input validation | Oversized upload |  |  |  |  |  |
| image-enhancement | Input validation | Image too small |  |  |  |  |  |
| image-enhancement | Credentials stay server-side | Inspecting the app |  |  |  |  |  |
| image-enhancement | Per-device rate limit | Limit exceeded |  |  |  |  |  |
| image-enhancement | Structured errors | Provider failure |  |  |  |  |  |
| image-enhancement | Structured errors | Slow provider |  |  |  |  |  |
| image-enhancement | No image retention by the service | After a request completes |  |  |  |  |  |
| enhanced-photo-review | Mode selection | Default mode |  |  |  |  |  |
| enhanced-photo-review | Mode selection | Mode remembered |  |  |  |  |  |
| enhanced-photo-review | Cloud processing disclosure | First capture |  |  |  |  |  |
| enhanced-photo-review | Cloud processing disclosure | Consent declined |  |  |  |  |  |
| enhanced-photo-review | Automatic enhancement after capture | Waiting for the result |  |  |  |  |  |
| enhanced-photo-review | Automatic enhancement after capture | Cancel |  |  |  |  |  |
| enhanced-photo-review | Upload preparation | Large crop |  |  |  |  |  |
| enhanced-photo-review | Upload preparation | Small crop |  |  |  |  |  |
| enhanced-photo-review | Before/after comparison | Drag the divider |  |  |  |  |  |
| enhanced-photo-review | Before/after comparison | Zoom into the comparison |  |  |  |  |  |
| enhanced-photo-review | AI-enhanced labeling | Creative result |  |  |  |  |  |
| enhanced-photo-review | Retry and switch mode | Try another mode |  |  |  |  |  |
| enhanced-photo-review | Retry and switch mode | Network failure |  |  |  |  |  |
| enhanced-photo-review | Retry and switch mode | Rate limited |  |  |  |  |  |
| enhanced-photo-review | Save to gallery | Save both |  |  |  |  |  |
| enhanced-photo-review | Save to gallery | Gallery permission denied |  |  |  |  |  |
| enhanced-photo-review | Return to camera | Leave without saving |  |  |  |  |  |

## Device details

| | Model | OS version | Lenses detected (zoom presets shown) | Max zoom shown |
|---|---|---|---|---|
| A |  |  |  |  |
| B |  |  |  |  |
| C |  |  |  |  |
| D |  |  |  |  |
