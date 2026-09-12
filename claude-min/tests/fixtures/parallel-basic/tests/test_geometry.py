import unittest
from geometry import rect_area
class T(unittest.TestCase):
    def test_area(self): self.assertEqual(rect_area(2, 3.5), 7.0)
    def test_negative(self):
        with self.assertRaisesRegex(ValueError, "sides must not be negative"): rect_area(-1, 2)
