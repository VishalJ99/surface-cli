# ADR 0046: Local attachments on threaded replies

Status: Accepted. Ticket: PER-518.

Reply and reply-all accept repeatable --attach using the existing local-file resolver. ReplyInput gains optional attachments for compatibility with existing callers. Gmail and IMAP keep In-Reply-To and References while adding MIME parts; Outlook uploads files into the existing reply composer before finalization. Both draft and send use this path. Original attachments are not automatically included. Public results expose metadata only. Forward is unchanged. This supersedes the reply deferral in ADR 0041.
