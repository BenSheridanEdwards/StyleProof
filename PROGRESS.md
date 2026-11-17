# Progress

#1413: repair the URL/comment token boundary in existing PR #1430. Six of eight new cases fail against the old exact source, and the proposal passes 101 affected-surface tests in memory. Actual compiled affected-surface checks passed 101 tests. Final full verify passed 7082 tests. Normal hooks and hosted gates follow. No public API, protected workflow or gate configuration changes.

#1417 and #1418 are delivered in PRs #1432 and #1433 with all protected checks passing and independent Astra approval recommendations. PR #1429 repairs the server opt-out boundary; its actual head and gate receipts remain in the delivery handoff. #1002 framework/config/check stages still await stage 2 landing; independent warning guidance follows.

Preserve queue, release and human holds for #1427, #1313, #1324/#1326/#1328/#1329 and PRs #1423/#1315/#1431.

[Thread](t3-thread://v2/ff5e723c-72ed-4a43-a941-deab3df7dddc/mcp:launch:e052fa7dd59d3911291e5ab771bce5ddcf275910b0b1e59a7552ff92cb1046b5).

Independent Astra review of 4f4b08ef found one remaining P2: selector interpolation can inject a global selector. The owner is adding a conservative interpolation escape guard and two independent public-function regressions. Both tests fail against the actual pre-fix compiled code; no additional delegate is used for this small finding. Final affected checks passed 103 tests; final full verify passed 7084 tests. Normal hooks and hosted gates follow.
