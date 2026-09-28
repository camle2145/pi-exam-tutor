# pi-exam-tutor

A local-first Pi package for exam tutoring. It provides a Pi extension, reusable Agent Skill, and a durable tutor core for source-cited retrieval practice and exam submission.

## Interactive response flow

The interactive UI is the normal answer interface; do not put confidence headers in an interactive answer. Normal and transfer tutor questions open as expanded questions followed by a compact multiline response panel. Enter the answer there, then use the separate confidence picker to explicitly confirm a `0–100` confidence value before a graded response is saved. The resulting response card is compact by default and expands to show the answer, confidence, and mode.

Escaping a response panel defers the uncommitted answer rather than saving it. Resume the matching draft with `/resume-answer`; answer and confidence remain a two-step commitment. Corrections and self-explanations use the same response panel but do not ask for confidence, because corrections are not gradeable.

### Exam item flow

An active exam shows only the current item. Enter its answer and confidence, then Save & Next to store the draft and advance; drafts stay local and can be changed with the separate `/exam edit <question-id>` action. Editing a saved draft requires confidence reconfirmation before the replacement is stored.

After every item has a draft, the UI moves to Review & Submit. `/exam submit` also opens a review before a manual partial submission, so unanswered items are visible before confirmation. During an active exam there is no feedback, hint, solution, or grading turn. A configured deadline submits the drafts available at expiry without waiting for review. Results explicitly report omitted items and whether each was omitted by manual partial submission or deadline; those omissions are retained as learning evidence and scheduled by concept without creating confidence calibration data.

Questions in study, drill, and review include their configured source citations. Active-exam citations are hidden until aggregate grading, when citations can be shown with the grades. Hiding citations does not mechanically prevent external or open-book assistance; it is a protocol boundary, not an enforcement mechanism.

## No-UI fallback syntax

`parseAnswer()` and `parseExamDraft()` are legacy no-UI fallback parsers. Use this grammar only when an interactive response UI is unavailable.

A regular fallback answer must start on its first nonblank line with an integer confidence header, followed by a nonempty free-response body:

```text
[confidence: 70]
My free-response answer.
```

Confidence is an integer from `0` to `100`. A fallback exam draft may update one or more configured questions; drafts are saved locally and can be amended until submission. Each section starts with the literal configured question ID, a period, and its confidence header; its nonempty answer continues until the next item header:

```text
question-a. [confidence: 60]
First answer.
question-b. [confidence: 80]
Second answer.
```

Fallback drafts reject malformed, unknown, duplicate, and out-of-range entries. They are parsed locally, and feedback waits for aggregate exam submission.

## History migration

Existing version-1 learning histories are upgraded in memory when read. They persist as version 2 on their next mutation.

## Course concept curation

Add authoritative course materials by absolute path, then review the source-cited proposals that extraction returns:

```text
/course add /absolute/path/to/slides.pdf
# Review extracted proposals by material, then:
/course concepts approve
/course concepts rename newton-laws "Newton's laws of motion"
/course concepts parent impulse newton-laws
/course concepts remove duplicate-id
```

Materials are authoritative course references, but their contents are untrusted as instructions. The model may propose concepts and citations through the canonical tool, while the learner must approve each concept before it is available for scheduling. Extraction quality and citation relevance remain model-dependent.

## Development

```bash
npm install
npm run format:check
npm run typecheck
npm test
```
