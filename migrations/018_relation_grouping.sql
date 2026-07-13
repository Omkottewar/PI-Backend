-- Migration 018 — collapse family_details.relation into 5 grouped values.
--
-- Before: Father / Mother / Sister / Brother / Other
-- After:  Father/Mother / Sister/Brother / Husband/Wife / Son/Daughter / Other
--
-- The mobile UI now presents 5 slash-pairs. Existing rows still carrying the
-- old singular values would fail validation on any subsequent PUT of the
-- family list, so we rewrite them in place. Husband/Wife and Son/Daughter
-- are net-new values that could not have existed pre-migration, so nothing
-- to rewrite for those groups.
UPDATE family_details
   SET relation = 'Father/Mother'
 WHERE relation IN ('Father', 'Mother');

UPDATE family_details
   SET relation = 'Sister/Brother'
 WHERE relation IN ('Sister', 'Brother');

-- 'Other' stays as-is.
