# Spec Delta

## MODIFIED Requirements

### Requirement: AI-enhanced labeling
The app SHALL clearly label the enhanced image as AI-enhanced and SHALL show the mode used. In Creative mode it SHALL also note that some detail may be invented. For a capture beyond the native-pixel limit, it SHALL instead label the result AI-reconstructed, in every mode, and say that most detail was generated.

#### Scenario: Creative result
- **WHEN** a Creative-mode result is shown
- **THEN** the result is labeled AI-enhanced (Creative) with a note that some detail may not match reality

#### Scenario: Extreme-zoom result
- **WHEN** a result is shown for a capture taken beyond the native-pixel limit, in any mode
- **THEN** it is labeled AI-reconstructed with a note that most detail was generated and may not match reality
