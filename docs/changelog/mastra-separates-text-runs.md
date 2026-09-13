# Summary

A Mastra agent that spoke, called a tool, then spoke again ran the two
sentences together in the chat: `...remaining 76.Batch 3 done (75/126).`

A turn's text does not arrive as one stream. Mastra emits a run of
`text-delta` chunks per model step, and a step that follows a tool call is a
fresh completion, so it opens with no leading whitespace of its own. The
adapter forwarded every delta with `hooks.onChunk(chunk.payload.text)`, and the
transport appends deltas verbatim, which is correct for tokens within a run and
wrong across runs.

The seam is only visible on an agent that reports progress between tool calls,
which is why it went unnoticed: a single-step reply has one run and no seam.

# Design

The adapter now tracks two facts per turn: whether text has been emitted, and
whether a tool call has interrupted it. A `text-delta` that opens a run after an
interruption is preceded by a blank line.

The interruption is recorded at `tool-call-input-streaming-start` rather than at
its end, so a tool that errors before reporting an end still separates the text
that follows it. The flag clears on the first delta of the resumed run, not on
every delta, because a run's later tokens split mid-word and a break between
them would cut the sentence.

Two cases are deliberately left alone. A run that opens the turn gets no leading
break, since nothing precedes it. A run whose first delta already begins with
whitespace gets none either, since the model supplied its own.

State lives on the turn rather than inside one stream segment, so text resuming
after an elicitation is separated from text before it.

`text-delta` chunks with empty text no longer count as a run. They were already
forwarded as empty appends; treating one as text would let it consume the break
that belongs to the next real run.

# Migration

None. The change affects only the text a multi-step turn streams, and only by
adding the paragraph break between steps that was missing.
