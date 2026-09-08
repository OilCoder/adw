def beta(value: int) -> int:
    """Add three to the value (wrong for small inputs: an interaction bug)."""
    return value + 3 if value >= 4 else value + 4
