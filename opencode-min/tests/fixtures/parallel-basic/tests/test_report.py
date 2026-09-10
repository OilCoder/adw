import unittest
from report import summary
class T(unittest.TestCase):
    def test_summary(self): self.assertEqual(summary([1, 2, 3], 2, 2), "mean=2.0 area=4.0")
