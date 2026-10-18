# ADR 0004: Party source files are read in the API and never stored

Status: accepted (Oct 2026). Replaces the presigned-upload path from step 2b.

## Context

Hosts attach a PDF or DOCX to make questions from. Step 2b had the app PUT the file to object storage
through a presigned URL, then the questions service downloaded and parsed it. That kept a copy of
whatever the host sent (notes, internal documents, other people's work) in a bucket indefinitely,
for no product reason: questions need the text, never the file. It also meant a phone needed to reach
the storage endpoint directly, and a file whose upload never arrived left a party waiting.

## Decision

- **The app sends the file to the API** as multipart: `PUT /parties/:id/files`, one file in the
  `file` field, capped at `MAX_UPLOAD_BYTES` (413 over it, 415 for a type we can't read). Host's team
  only, while the party is open and before its questions are made. Rate-limited per minute.
- **The API reads it in memory, off the event loop.** The bytes are transferred to a worker thread
  (`apps/api/src/sources/`) that extracts the text and chunks it; only the chunks come back, and the
  bytes are gone when the request ends. A read that runs past a timeout is stopped.
- **Only the chunks are kept**, in `file_chunks`, with the file's metadata (name, type, size, status)
  in `party_files`. Nothing goes to object storage, and queue payloads carry ids only: the API queues
  `file_read { fileId }`, and the questions service embeds the stored chunks and marks the file
  `parsed`. A file the API couldn't read is stored as `failed` with a reason for the host, and still
  queues `file_read`, so a sealed set waiting for it fails in words the host can act on.
- **A new file replaces the old one.** Its row and chunks are deleted in the same transaction that
  stores the new ones. A failed set is fixed by sending a new file and retrying.
- **Retention.** The questions service's daily `source_sweep` deletes a party's file records and
  chunks `sourceRetentionDays` (questions config, default 30) after the party finished or was
  cancelled (`parties.ended_at`). Until then they're there for disputes and flag review. Generation
  records keep the cited chunk's id; after the sweep the text behind it is gone.
- `packages/storage` stays, for media people keep (avatars, covers, voice notes), which still go
  straight to storage through presigned URLs.

## Alternatives considered

- **Presigned upload, delete after parsing.** Still stores the file for a while, still needs the
  phone to reach storage, and a failed delete leaves a copy. Reading in the request is simpler.
- **Parse in the questions service from a queued payload.** Puts up to 10 MB of a host's file in
  Valkey, which is exactly the copy we're trying not to keep.
- **Extract on the event loop.** A large PDF would stall every other request on that instance.

## Consequences

- The API carries the PDF/DOCX extractors (`unpdf`, `mammoth`) and the chunker; the questions
  service no longer reads files, only embeds and retrieves.
- A request that sends a file takes as long as the read (a few hundred ms for a typical file).
- `file_chunks.embedding` is null until the questions service has indexed it; retrieval only ever
  reads chunks of `parsed` files.
