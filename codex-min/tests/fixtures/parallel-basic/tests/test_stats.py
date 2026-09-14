import unittest
from stats import mean
class T(unittest.TestCase):
    def test_mean(self): self.assertEqual(mean([1, 2, 3, 4]), 2.5)
    def test_empty(self):
        with self.assertRaisesRegex(ValueError, "values must not be empty"): mean([])
