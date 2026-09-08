import unittest

from lib.alpha import alpha
from lib.beta import beta


class AlphaInteractionTest(unittest.TestCase):
    def test_composes_with_beta(self):
        try:
            result = beta(alpha(1))
        except NotImplementedError:
            self.skipTest("beta not implemented yet")
        self.assertEqual(result, 5)
