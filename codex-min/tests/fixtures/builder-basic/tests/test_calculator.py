import unittest

from calculator import safe_divide


class SafeDivideTests(unittest.TestCase):
    def test_divides_evenly(self) -> None:
        self.assertEqual(safe_divide(8, 2), 4.0)

    def test_preserves_fraction(self) -> None:
        self.assertEqual(safe_divide(3, 2), 1.5)

    def test_rejects_zero_divisor(self) -> None:
        with self.assertRaisesRegex(ValueError, "divisor must not be zero"):
            safe_divide(5, 0)


if __name__ == "__main__":
    unittest.main()
