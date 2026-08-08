-- Deduplicate flight_offers keeping the oldest row for each searchHash + duffelOfferId pair
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
