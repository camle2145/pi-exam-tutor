# pi-exam-tutor

A Pi package for exam tutoring. This package provides a Pi extension and skills;
its tutor core is added in subsequent development tasks.

## Answer and exam-draft syntax

A regular answer must start on its first nonblank line with an integer confidence header, followed by a nonempty free-response body:

```text
[confidence: 70]
My free-response answer.
```

Confidence is an integer from 0–100. An exam draft contains every configured question exactly once. Each section starts with the literal configured question ID, a period, and its confidence header; its nonempty answer continues until the next item header:

```text
question-a. [confidence: 60]
First answer.
question-b. [confidence: 80]
Second answer.
```

Drafts reject malformed, unknown, duplicate, missing, and out-of-range entries. Exam drafts are parsed locally; feedback waits for aggregate exam submission.

## Development

```bash
npm install
npm run format:check
npm run typecheck
npm test
```
