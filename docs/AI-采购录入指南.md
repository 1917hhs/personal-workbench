# AI 录入询价与回价操作指南

给接入「个人工作台」的 AI 助手（WorkBuddy、Claude 等）看的说明：用户把询价文件、回价文件交给你时，怎样判断、怎样写进软件。通过 MCP 用 `get_procurement_guide` 随时读取本指南。

## 1. 数据结构

```
项目 project ── 询价 inquiry（一个项目的一个专业包 / 一个采购范围）
                 ├─ 询价文件版次 versions[]   我方发出的 RFQ、清单、图纸、技术要求，按 V1、V2… 排，新版生效、旧版作废
                 ├─ 发包记录 sends[]          发给了哪家单位，状态：已发送 / 已回价 / 未回复 / 放弃报价
                 └─ 回价 quotes[]             每家单位每一轮的报价
单位 company（供应商、业主、设计院等）── 联系人 contact、入库资料 docs、项目经验 experience
```

| 对象 | 关键字段 | 说明 |
| --- | --- | --- |
| 询价 inquiry | name, projectId, discipline, currency, deadline, scope, status, budget, budgetNote | status：编制中 → 询价中 → 比价中 → 已定标 / 取消。budget 是我方控制价 / 测算价（不含税） |
| 询价文件版次 | version, date, summary, files | 用 `add_inquiry_version` 添加，文件会复制到「03 询价文件/<询价>/V<n>」 |
| 发包记录 | companyId, date, channel, deadline, status | 用 `add_send`；录回价时没有发包记录会自动补 |
| 回价 quote | companyId, amount, currency, rate, tax, taxRate, amountWithTax, date, round, versionNo, quoteNo, validTo, leadDays, payment, scopeNote, deviation, verify, issues, files | 见第 4 节 |
| 单位 company | name, enName, unitType, category, specialties, serviceCountries, status, grade | 用 `list_companies` 查重，没有再 `add_company` |

不要直接改数据文件（companies.json、inquiries.json 等）：软件运行时会覆盖，用户也看不到、撤销不了。一律通过 MCP 工具写入。

## 2. 标准流程

1. `get_user_profile`：先读用户档案，按用户的习惯和口径做。
2. 逐份读文件，判断每份是**询价文件**还是**回价**（第 3 节），并摘出报价方、范围、金额、税、日期、有效期、付款条件。
3. `list_inquiries`（按项目）找对应的询价；范围一致就归进同一条，确实没有再 `add_inquiry`。
4. 报价方用 `list_companies` 按名称查（会忽略大小写、空格、标点和土耳其字母的附加符号）；没有就 `add_company`，source 写清来源（如「示例光伏 POT 回价」）。
5. 询价文件用 `add_inquiry_version`；每份回价用 `add_quote`，带上原件路径。
6. 有疑点的回价照常录入，但 `verify` 填「待核实」、`issues` 写清楚疑点，最后集中向用户汇报，不要自己猜着改数字。
7. 最后用 `get_inquiry` 复核比价结果，向用户汇报：录了什么、最低价、待核实事项、需要用户决定的事。

## 3. 怎样判断文件类型和归属

- **询价文件（我方发出）**：标题是 Request for Quotation / RFQ / 询价函，有 RFQ 编号、截止时间，价格表写着 “to be completed by the Bidder”，签发方是我方（总包单位）。→ `add_inquiry_version`。
  - 如果询价文件里的价格表已经填了数（没有报价方署名），多半是我方测算的控制价，不是供应商报价：先问用户，确认后用 `update_inquiry` 写进 `budget` / `budgetNote`，不要当成回价录入。
- **回价（供应商发来）**：有供应商抬头、签字盖章，标题如 FİYAT TEKLİFİ、COMMERCIAL OFFER、Quotation、报价单。→ `add_quote`。
- **是否同一条询价**：按范围和数量判断，不按文件标题。例：「47 adet zemin delgisi ve 3 adet kolon çakımı」= 47 根预钻孔混凝土桩 + 3 根直接锤入桩 = 50 根试桩，和 RFQ 的 50 根试桩是同一范围。范围明显不同（如只报了其中一部分）时，在 `scopeNote` 写明差异；整体口径不同才另建询价。
- **轮次与版次**：`versionNo` 填这份报价响应的是第几版询价文件；同一家后来又报价就是下一轮 `round`。早于当前询价文件的报价（如 RFQ R1 之前的 8 月报价）照样录入，`versionNo` 留空并在 `note` 写「RFQ 前的早期报价」。

## 4. 回价字段怎么填

| 字段 | 怎么填 |
| --- | --- |
| amount | 不含税净价（土耳其报价的 TOPLAM / Net，不是 GENEL TOPLAM） |
| tax / taxRate / amountWithTax | 报价不含税就填「不含税」，税率写 taxRate（土耳其 KDV 一般 20），含税总价写 amountWithTax（GENEL TOPLAM）。只写了 “+ VAT” 没列金额的，amountWithTax 留空 |
| currency / rate | 币种照报价；TL 一律写 TRY；不是 USD 时填 rate（1 单位币种 = 多少 USD）便于比价 |
| date | 报价日期；有修订日期（Revize）时用修订日期，原日期写进 note |
| quoteNo | 报价编号，如 DNM-2026-017 REV1 |
| validTo / validDays / validDaysType | 有效期写成天数时用 validDays，并用 validDaysType 说明「工作日」或「日历日」，工具会按报价日期算出 validTo（工作日跳过周六日） |
| payment | 付款条件，如「50% 预付，交付后 7 天内付 50%」「30/40/20/10」 |
| leadDays | 工期 / 交货期（天）；只写了「浇筑后 15 天测试」这类条件的写进 scopeNote |
| scopeNote | 报价范围、包含与不包含的内容，以及与询价范围的差异 |
| deviation | 技术偏差 |
| files | 原件的绝对路径，工具会复制到「04 回价与比价/<询价>/<单位>」 |
| verify / issues | 有疑点就填「待核实」并写明，例如下面这些 |

常见疑点（写进 issues）：

- 金额数字和大写不一致（如数字 110,000、大写 Seventy Thousand）→ 按数字录入，标待核实。
- 报价抬头的客户不是我方（如写给另一家公司而不是我方），可能是转手或中间商。
- 两家报价的条款逐字相同、价格接近，可能同源或串标，提醒用户注意。
- 报价方不在单位库里（已新建，入库状态为「名录收集」）。
- 有效期很短（如 3 个工作日）且已过期。
- 范围不全、单位或数量和询价文件对不上。

## 5. 示例：示例光伏项目 POT（试桩）

以下公司名、编号和金额均为虚构，只用来说明录法。

询价：「示例光伏 POT 试桩」，项目「示例光伏项目」，专业「桩基」，币种 USD，范围 50 根试桩（47 预钻孔 + 3 锤入）+ 50 拉拔 + 50 水平试验 + 报告。

| 文件 | 类型 | 录法 |
| --- | --- | --- |
| RFQ for POT tests.docx（RFQ No. DEMO-POT-RFQ-R1，2026-03-02 签发，03-06 17:00 截止，签发方我方） | 询价文件 | `add_inquiry_version`，summary 写 RFQ 编号和截止时间。表里已填的 60,000.00 USD 没有报价方署名，先问用户是否为我方控制价，确认后写 budget |
| offer_a.pdf（Örnek Zemin Ltd.，2026-03-05，修订 03-06） | 回价 | amount 30,000 USD，不含税，taxRate 20，amountWithTax 36,000；date 2026-03-06（原 03-05）；validDays 3 工作日；payment 50% 预付 + 交付后 7 天内 50%；versionNo 1；新建单位 Örnek Zemin Ltd. |
| offer_b.pdf（Deneme Yapı A.Ş.，DNM-2026-017 REV1，2026-03-05） | 回价 | amount 31,200 USD，不含税，taxRate 20，amountWithTax 37,440；quoteNo 写编号；validDays 3 工作日；versionNo 1；issues：抬头客户是另一家公司（XYZ Enerji）不是我方；条款与 Örnek 逐字相同 |
| offer_c.pdf（Beta Altyapı，2025-12-15） | 回价 | amount 110,000 USD，不含税（+VAT 未列额）；validDays 30 日历日（已过期）；payment 30/40/20/10；note「RFQ 前的早期报价」；issues：大写写的是 Seventy Thousand，与数字不符 |
