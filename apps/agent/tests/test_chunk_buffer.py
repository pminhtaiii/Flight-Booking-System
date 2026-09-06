from agent.streaming.chunk_buffer import ChunkBuffer


def test_buffer_tracks_normalized_to_raw_offsets():
    buffer = ChunkBuffer()
    buffer.add_token("Cafe\u0301 and ")
    assert buffer.normalized_text == "Caf\u00e9 and "
    assert buffer.raw_index_for_normalized_index(4) == 4


def test_release_raw_prefix_preserves_suffix_mapping():
    buffer = ChunkBuffer()
    buffer.add_token("safe text. " + "x" * 600)
    released = buffer.release_raw_prefix(len("safe text. "))
    assert released == "safe text. "
    assert buffer.raw.startswith("x")
    assert buffer.normalized_text.startswith("x")


def test_flush_returns_all_pending_raw_text_and_is_idempotent():
    buffer = ChunkBuffer()
    buffer.add_token("remaining text")
    assert buffer.flush() == "remaining text"
    assert buffer.flush() == ""


def test_raw_utf8_pending_limit_is_explicit():
    buffer = ChunkBuffer()
    buffer.add_token("\u00e9")
    assert len(buffer.raw.encode("utf-8")) == 2
