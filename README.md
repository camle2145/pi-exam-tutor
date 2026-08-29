# pi-exam-tutor

A Pi package for exam tutoring. This package provides a Pi extension and skills;
its tutor core is added in subsequent development tasks.

## Answer and exam-draft syntax

A regular answer must start on its first nonblank line with an integer confidence header, followed by a nonempty free-response body:

```text
[confidence: 70]
My free-response answer.
```

Confidence is an integer from 0–100. An exam draft may update one or more configured questions; drafts are saved locally and can be amended until submission. Each section starts with the literal configured question ID, a period, and its confidence header; its nonempty answer continues until the next item header:

```text
question-a. [confidence: 60]
First answer.
question-b. [confidence: 80]
Second answer.
```

Drafts reject malformed, unknown, duplicate, and out-of-range entries. Exam drafts are parsed locally; feedback waits for aggregate exam submission.

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

## Exam submission

Exam answers stay local and amendable after every configured question has a saved draft. Run `/exam submit` when ready; no model feedback is requested before then. An exam deadline submits the drafts available at expiry, after which aggregate grading occurs through the canonical grade tool.

## Development

```bash
npm install
npm run format:check
npm run typecheck
npm test
```
