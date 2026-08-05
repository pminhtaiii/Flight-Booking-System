import pytest
from agent.streaming.chunk_buffer import ChunkBuffer

def test_basic_sentence_boundaries():
    # Test '. ', '! ', '? ', '\n' followed by uppercase
    buffer = ChunkBuffer(max_chunk_tokens=50)
    
    # 1. Period boundary
    assert buffer.add_token("Hello world") is None
    assert buffer.add_token(". ") is None
    # Boundary is triggered when the next non-whitespace uppercase character arrives
    assert buffer.add_token("This is next") == "Hello world. "
    
    # 2. Exclamation boundary
    assert buffer.add_token("! ") is None
    assert buffer.add_token("Here we go") == "This is next! "
    
    # 3. Question boundary
    assert buffer.add_token("? ") is None
    assert buffer.add_token("What is this") == "Here we go? "
    
    # 4. Newline boundary followed by uppercase
    assert buffer.add_token("\n") is None
    assert buffer.add_token("Indeed it is") == "What is this\n"
    
    # Flush should return the rest
    assert buffer.flush() == "Indeed it is"

def test_no_split_lowercase():
    # Should not split if the next non-whitespace character is lowercase
    buffer = ChunkBuffer()
    assert buffer.add_token("Hello world. ") is None
    assert buffer.add_token("this is lowercase") is None
    assert buffer.flush() == "Hello world. this is lowercase"

def test_code_block_fence():
    # Should not split inside triple-backtick code fences
    buffer = ChunkBuffer()
    assert buffer.add_token("Here is code:\n```python\n") is None
    assert buffer.add_token("x = 1.0\n") is None
    assert buffer.add_token("if x > 0:\n") is None
    assert buffer.add_token("    print('Ok!')\n") is None
    assert buffer.add_token("```\n") is None
    # Now we are outside the code block, next sentence should split normally
    assert buffer.add_token("Outside now. ") == "Here is code:\n```python\nx = 1.0\nif x > 0:\n    print('Ok!')\n```\n"
    assert buffer.add_token("Yes we are") == "Outside now. "
    assert buffer.flush() == "Yes we are"


def test_abbreviation_heuristics():
    # Should skip splitting on abbreviation heuristics
    buffer = ChunkBuffer()
    
    # Single uppercase letter preceding dot
    assert buffer.add_token("Check flight A. ") is None
    assert buffer.add_token("Then book B. ") is None
    # Normal split after abbreviation sequence
    assert buffer.add_token("We are done. ") is None
    assert buffer.add_token("Perfect") == "Check flight A. Then book B. We are done. "
    assert buffer.flush() == "Perfect"
    
    # Common abbreviations: Mr., Dr., St.
    buffer2 = ChunkBuffer()
    assert buffer2.add_token("Dr. Smith met Mr. Jones on St. Jude road. ") is None
    assert buffer2.add_token("They had a meeting. ") == "Dr. Smith met Mr. Jones on St. Jude road. "
    assert buffer2.flush() == "They had a meeting. "

    # Compound time abbreviations: a.m., p.m., am, pm
    buffer3 = ChunkBuffer()
    assert buffer3.add_token("We arrive at 10 p.m. Wednesday. ") is None
    assert buffer3.add_token("Then we leave at 8 a.m. Thursday. ") == "We arrive at 10 p.m. Wednesday. "
    assert buffer3.add_token("Flight at 12 pm. Friday. ") == "Then we leave at 8 a.m. Thursday. "
    assert buffer3.add_token("Ok") == "Flight at 12 pm. Friday. "
    assert buffer3.flush() == "Ok"

def test_decimal_numbers():
    # Should skip splitting on decimal numbers (dot preceded by digits and followed by digit)
    buffer = ChunkBuffer()
    assert buffer.add_token("The price is $1,234.56. ") is None
    assert buffer.add_token("This is cheap") == "The price is $1,234.56. "
    assert buffer.flush() == "This is cheap"

def test_force_split_at_max_tokens():
    # Should force-split when max_chunk_tokens is exceeded without finding a boundary
    # We use a small limit of 5 tokens for testing
    buffer = ChunkBuffer(max_chunk_tokens=5)
    
    # In cl100k_base, each word here is roughly 1 token
    # "one two three four five six seven eight"
    assert buffer.add_token("one ") is None
    assert buffer.add_token("two ") is None
    assert buffer.add_token("three ") is None
    assert buffer.add_token("four ") is None
    # Adding "five " makes the buffer 6 tokens, exceeding 5. It should split.
    chunk = buffer.add_token("five ")
    assert chunk is not None
    assert "one two three four five" in chunk
    
    # The trailing space and "six " will remain/be added next
    assert buffer.add_token("six ") is None
    assert buffer.flush().strip() == "six"


def test_flush_returns_remaining():
    buffer = ChunkBuffer()
    assert buffer.add_token("Some remaining text without punctuation") is None
    assert buffer.flush() == "Some remaining text without punctuation"
    assert buffer.flush() is None  # Second flush on empty buffer should return None
