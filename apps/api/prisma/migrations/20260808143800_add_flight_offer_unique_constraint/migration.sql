-- Deduplicate flight_offers keeping the oldest row for each searchHash + duffelOfferId pair
WITH CanonicalOffers AS (
  SELECT "searchHash", "duffelOfferId", id AS canonical_id
  FROM (
    SELECT "searchHash", "duffelOfferId", id,
           ROW_NUMBER() OVER(PARTITION BY "searchHash", "duffelOfferId" ORDER BY "createdAt" ASC) as row_num
    FROM "flight_offers"
  ) t
  WHERE t.row_num = 1
)
UPDATE "booking_intents"
SET "flightOfferId" = c.canonical_id
FROM "flight_offers" fo
JOIN CanonicalOffers c ON fo."searchHash" = c."searchHash" AND fo."duffelOfferId" = c."duffelOfferId"
WHERE "booking_intents"."flightOfferId" = fo.id AND fo.id != c.canonical_id;

WITH CanonicalOffers AS (
  SELECT "searchHash", "duffelOfferId", id AS canonical_id
  FROM (
    SELECT "searchHash", "duffelOfferId", id,
           ROW_NUMBER() OVER(PARTITION BY "searchHash", "duffelOfferId" ORDER BY "createdAt" ASC) as row_num
    FROM "flight_offers"
  ) t
  WHERE t.row_num = 1
)
UPDATE "chat_handoffs"
SET "flightOfferId" = c.canonical_id
FROM "flight_offers" fo
JOIN CanonicalOffers c ON fo."searchHash" = c."searchHash" AND fo."duffelOfferId" = c."duffelOfferId"
WHERE "chat_handoffs"."flightOfferId" = fo.id AND fo.id != c.canonical_id;

DELETE FROM "flight_offers"
WHERE id IN (
  SELECT id
  FROM (
    SELECT id, ROW_NUMBER() OVER(PARTITION BY "searchHash", "duffelOfferId" ORDER BY "createdAt" ASC) as row_num
    FROM "flight_offers"
  ) t
  WHERE t.row_num > 1
);

-- CreateIndex
CREATE UNIQUE INDEX "flight_offers_searchHash_duffelOfferId_key" ON "flight_offers"("searchHash", "duffelOfferId");
