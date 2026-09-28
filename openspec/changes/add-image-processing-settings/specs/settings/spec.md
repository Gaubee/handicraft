# 设置能力域（settings）——图像处理分区

> 新能力域：daemon settings 表的用户可见设置面。首个 requirement 覆盖图像处理分区；模型服务分区 spec 见各自 change 归档。

### Requirement: 图像处理四档预设

设置页 SHALL 提供图像处理分区，含 `快速`/`性能`/`高质量`/`自定义` 四档。前三档 SHALL 为服务端冻结映射（快速=15px/cm+conf 0.50+掩码长边 1024；性能=25px/cm+conf 0.40+原尺寸；高质量=40px/cm+conf 0.30+原尺寸——映射单源在 daemon）；保存非 custom 档时服务端 SHALL 按映射生成 values 快照落库（入参 values 忽略）。自定义档 SHALL 放开四参数：`ppcmTarget`(int 10..50)、`resampleEnabled`(bool)、`samConfThreshold`(0.05..0.95)、`samMaskMaxSide`(int ≥32 或 null=原尺寸)，越界/缺失 SHALL typed 拒。

#### Scenario: 预设保存

- **when** 用户选「快速档」保存 → settings 键落 `{preset:'fast', values:{ppcmTarget:15, resampleEnabled:true, samConfThreshold:0.50, samMaskMaxSide:1024}}`（快照，后续映射定义演进不影响已保存用户）
- **when** custom 档保存缺 values 或 ppcm=9 → typed 拒（invalid-input）
- **when** 非 custom 档携带被篡改的 values 入参 → 服务端忽略，按冻结映射落库

### Requirement: 设置双层真源与来源透明

生效值解析 SHALL 单源：settings 键在场且 JSON 合法 → 真源（`source='settings'`）；未写入且 `PPCM_TARGET`/`PPCM_RESAMPLE` env 在场 → env 解析（`source='env'`：ppcm clamp 10..50 坏值 25、resample!=='0'，SAM 两字段无 env 键回落缺省映射）；否则内置缺省=性能档映射（`source='default'`）。坏 JSON SHALL 按未写入容错。UI SHALL 透出生效来源（设置（档名）/环境变量/默认（性能档）），并提供「恢复跟随环境/默认」动作（=删 settings 键）。

#### Scenario: 真源与回落

- **when** 未保存且 PPCM_TARGET=40 → effective.ppcmTarget=40、source='env'
- **when** 保存快速档后 env 改 PPCM_TARGET=40 → effective 仍=15（settings 真源，env 不参与）
- **when** 执行 reset → 键删除，回 env/default 跟随

### Requirement: 调用时解析生效（不重启）

图像处理设置 SHALL 在每次消费时解析，保存后对 daemon/kernel 存续会话的下一次请求立即生效：scene-analysis 入线降采 SHALL 经注入 provider 每次 `analyze()` 取值（直注测试注入面保留且优先）；SAM 桥请求 SHALL 经注入调谐函数取 `confThreshold`/`maskMaxSide` 并条件透传 wire params（undefined 不发=服务端缺省，wire 兼容）。

#### Scenario: 改设置立即生效

- **when** 同一 kernel 会话内保存「快速档」（原默认）→ 下一次 analyze 的 intake 工件按 15px/cm 降采、下一次 subject.segment wire params 含 `confThreshold:0.50, maskMaxSide:1024`
- **when** 生效值 maskMaxSide=null → wire 不发该字段（服务端原尺寸缺省）
