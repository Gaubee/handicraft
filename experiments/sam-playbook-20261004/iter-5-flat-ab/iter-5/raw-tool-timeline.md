# iter-5 工具调用时间线（全量 42 次去重调用；源=activity 帧按 activityId 聚合，末态为代表）

| # | epochMs | 工具 | 状态 | 标签 | 耗时ms | 输出摘要 |
|---|---|---|---|---|---|---|
| 1 | 1791090676903 | todo_write | ok | 更新待办 | 24 | Updated todo list: 5 pending, 2 in progress, 0 completed. |
| 2 | 1791090676929 | studio.kb_list | ok | 知识库检索 | 26 |  |
| 3 | 1791090676956 | studio.scene.analyze | error | 识图分析 | 144643 |  |
| 4 | 1791090835983 | studio.kb_get | ok | 知识库读取 | 24 |  |
| 5 | 1791090836008 | studio.kb_get | ok | 知识库读取 | 17 |  |
| 6 | 1791090836025 | studio.scene.analyze | error | 识图分析 | 149729 |  |
| 7 | 1791091022919 | studio.kb_get | ok | 知识库读取 | 74 |  |
| 8 | 1791091022994 | studio.scene.analyze | error | 识图分析 | 178782 |  |
| 9 | 1791091375408 | studio.subject.segment | ok | 抠图分件 | 440580 |  |
| 10 | 1791091906220 | studio.tree.reparent | error | 图层归属调整 | 17 |  |
| 11 | 1791091940534 | studio.scene.analyze | ok | 识图分析 | 57733 |  |
| 12 | 1791092011926 | studio.tree.reparent | error | 图层归属调整 | 39 |  |
| 13 | 1791092077848 | studio.task.stones.list | ok | 查看用钻清单 | 39 | note=candidates=可追加候选（库内现存未引入）；追加前先与用户讨论确认（studio.ta… |
| 14 | 1791092096055 | stones.search | ok | 钻库搜索 | 24 | total=9 |
| 15 | 1791092096080 | stones.search | ok | 钻库搜索 | 19 | total=20 |
| 16 | 1791092096100 | stones.search | ok | 钻库搜索 | 19 | total=6 |
| 17 | 1791092096119 | stones.search | ok | 钻库搜索 | 16 | total=5 |
| 18 | 1791092096136 | stones.search | ok | 钻库搜索 | 15 | total=6 |
| 19 | 1791092096151 | stones.search | ok | 钻库搜索 | 15 | total=16 |
| 20 | 1791092145656 | stones.search | ok | 钻库搜索 | 26 | total=1 |
| 21 | 1791092157735 | stones.search | ok | 钻库搜索 | 25 | total=31 |
| 22 | 1791092179393 | studio.task.stones.add | ok | 追加用钻 | 42 |  |
| 23 | 1791092183873 | studio.task.stones.add | ok | 追加用钻 | 46 |  |
| 24 | 1791092228140 | todo_write | ok | 更新待办 | 11 | Updated todo list: 1 pending, 1 in progress, 5 completed. |
| 25 | 1791092228152 | studio.strategy.design | error | 策略设计 | 29 |  |
| 26 | 1791092255316 | stones.list | ok | 钻库检索 · dots | 37 | total=89 |
| 27 | 1791092267811 | stones.search | ok | 钻库搜索 | 29 | total=19 |
| 28 | 1791092291738 | studio.task.stones.add | ok | 追加用钻 | 22 |  |
| 29 | 1791092298067 | studio.task.stones.add | ok | 追加用钻 | 106 |  |
| 30 | 1791092313113 | studio.strategy.design | error | 策略设计 | 203697 |  |
| 31 | 1791092533182 | studio.strategy.design | ok | 策略设计 | 219169 |  |
| 32 | 1791092809242 | studio.strategy.design | ok | 策略设计 | 157202 |  |
| 33 | 1791092973180 | studio.strategy.design | ok | 策略设计 | 3065 | note=工件名约定（emit 层消费）：strategy-plan.json / strategy-g… |
| 34 | 1791093080850 | studio.strategy.design | ok | 策略设计 | 148942 |  |
| 35 | 1791093237085 | studio.strategy.design | ok | 策略设计 | 3446 | note=工件名约定（emit 层消费）：strategy-plan.json / strategy-g… |
| 36 | 1791093293187 | studio.strategy.design | error | 策略设计 | 70933 |  |
| 37 | 1791093375902 | studio.strategy.design | error | 策略设计 | 92411 |  |
| 38 | 1791093492929 | studio.strategy.design | ok | 策略设计 | 80761 |  |
| 39 | 1791093582790 | studio.strategy.design | ok | 策略设计 | 4516 | note=工件名约定（emit 层消费）：strategy-plan.json / strategy-g… |
| 40 | 1791093601463 | todo_write | ok | 更新待办 | 10 | Updated todo list: 0 pending, 1 in progress, 5 completed. |
| 41 | 1791093601474 | studio.task.export | ok | 导出任务工件 | 2214 |  |
| 42 | 1791093616247 | studio.task.export | ok | 导出任务工件 | 7495 |  |
