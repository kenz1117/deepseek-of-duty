# 附录

## A. 术语表

| 术语 | 定义 |
| --- | --- |
| Agent（智能体） | 能够自主感知环境、规划任务并调用工具完成目标的 AI 系统，通常具备多步推理与行动能力。 |
| RAG（检索增强生成，Retrieval-Augmented Generation） | 在生成回答前先从外部知识库检索相关事实，以缓解大模型幻觉、提升回答准确性的技术范式。 |
| POC（概念验证，Proof of Concept） | 在正式投入前以小成本验证技术或方案可行性的阶段性实验，用于确认"能不能做"。 |
| 成果分成 | 服务商按其为客户创造的可量化业务价值（降本、增收等）分享收益的计费与激励模式，区别于固定人天计价。 |
| 吨钢成本 / 人效 | 制造等行业的典型业务指标；前者衡量单位产品的资源消耗，后者衡量人均产出，常作为 AI 交付价值的量化基线。 |
| 信创（信息技术应用创新） | 以国产化软硬件替代为核心的信息技术应用创新体系，涉及芯片、操作系统、数据库等自主可控要求。 |
| 驻场交付 | 服务人员长期驻扎客户现场开展实施、调试与运营的交付形态，是 FDE 工作的典型方式。 |
| 可解释 AI（Explainable AI） | 使 AI 决策过程与依据可被人类理解、审计与追溯的技术与方法，在强监管行业尤为关键。 |

## B. 调研方法论

**数据来源类型。**本报告综合运用了多类型一手与二手资料，具体包括：招聘平台公开岗位数据（用于刻画岗位供给与薪资趋势）、行业研究报告（研究机构与协会发布的市场与生态分析）、企业财报与公开案例（用于验证商业模式与落地效果）、政策文件（中央与地方关于智能体、人才培育的规划与专项政策）、行业媒体深度报道（用于捕捉一线从业者真实体感与行业情绪）。

**市场规模估算的假设与局限。**本报告对 FDE 相关市场规模的估算采用自下而上（bottom-up）口径：以典型企业 FDE 团队配置规模、岗位薪资中位数、渗透率假设为输入，自下而上推演总量。该口径的优点是锚定可观测的真实变量，但存在明确局限——FDE 作为新兴复合岗位，尚无统一的统计口径，岗位名称高度离散（常以"AI 交付""解决方案架构师"等名义出现），渗透率假设易被高估或低估；同时，智能体、信创等政策驱动存在不确定性。因此，本报告所有规模数字均应被视为**可被新证据推翻的区间估计**，而非精确预测，使用者应结合后续官方统计与平台数据动态修正。

## C. 数据来源清单索引

为便于核验与延伸阅读，以下列出本报告代表性出处的类型与示例：

- **招聘平台数据** ：BOSS直聘、猎聘、Indeed 等。其中 Indeed 平台 FDE 相关岗位由 2023 年的约 643 个增长至近 5330 个，增幅超过 700%，是岗位爆发式增长的关键量化证据；BOSS直聘、猎聘用于交叉验证国内薪资与需求结构。
- **研究机构报告** ：腾讯研究院关于 AI 应用与智能体产业的系列研究报告，提供产业趋势与生态判断。
- **行业组织白皮书** ：崔牛会等企业服务领域机构发布的白皮书，用于印证企业软件与 AI 交付的演进路径。
- **企业实践案例** ：用友等企业的成果分成落地案例，作为"与业务成果绑定"激励机制的可验证样本。
- **行业媒体报道** ：包括探讨 FDE 从业者真实处境的报道（如"第一批做 FDE 的人，离高薪差远了"等），用于捕捉岗位期待与现实落差的行业情绪。
- **政策文件** ：北京市、武汉市发布的智能体专项政策，以及上海市人才培育相关政策，用于分析地方层面对智能体产业与复合型人才的扶持导向。

上述来源共同构成报告的证据底座。鉴于部分来源为非结构化公开信息且处于快速演化中，报告在引用时优先采用可交叉验证的事实，对单一来源的主观判断均予标注并审慎处理。

## C.1 第三方权威研究与厂商来源索引（含 URL 与可信等级）

> 为提升数据可追溯性，本节列出本报告引用的关键第三方来源。可信等级说明：**A 级**为权威机构报告、上市公司公开文件或企业官方发布，用于支撑趋势与关键判断；**B 级**为企业公开案例、工程博客与伙伴网络材料，用于说明角色边界、交付模式与实践样本，不当作全市场统计。

| 来源 | 平台 | 可信等级 | 本报告使用口径 |
| --- | --- | --- | --- |
| Gartner：Agentic AI 决策与企业软件预测 | Gartner Newsroom | A | 判断 Agent 进入企业软件与日常决策的趋势 |
| Gartner：AI-ready data 与项目放弃风险 | Gartner Newsroom | A | 说明数据准备不足影响 AI 项目进入生产 |
| Gartner：Agentic AI 项目取消风险 | Gartner Newsroom | A | 说明 Agent 项目热度高、治理难度也高 |
| McKinsey：The State of AI 2025 | McKinsey / QuantumBlack | A | 解释企业 AI 使用率与经营回报落差 |
| BCG：AI Value Gap 2025 | Boston Consulting Group | A | 观察 AI 规模价值与组织能力差异 |
| BCG：AI at Work 2025 | Boston Consulting Group | A | 说明员工采用、培训与管理落差 |
| Microsoft / LinkedIn：Work Trend Index 2024 | Microsoft WorkLab | A | 说明影子 AI、员工自带工具与组织采用 |
| IBM：Cost of a Data Breach Report 2025 | IBM | A | 提示数据安全、访问控制与追责机制重要性 |
| Cisco：AI Readiness Index 2024 | Cisco | A | 观察企业 AI 准备度与治理压力 |
| PwC：AI Jobs Barometer 2025 | PwC | A | 观察 AI 对岗位、薪酬与技能结构影响 |
| 中国信通院：企业级 SaaS 产业发展研究报告 2024 | 中国信息通信研究院 | A | 理解中国企业服务软件付费与交付语境 |
| OpenAI：Deployment Company | OpenAI 官方公告 | B | 作为模型公司补齐企业部署能力的组织信号 |
| Anthropic：Claude Partner Network | Anthropic 官方公告 | B | 作为企业 AI 服务伙伴网络形成的案例样本 |
| Salesforce Engineering：Agentforce FDE 案例 | Salesforce Engineering | B | 说明 FDE 在平台公司里的具体实践边界 |
| Palantir：S-1（2020） | 美国 SEC EDGAR | A | 理解 FDE 历史参照、现场工程与产品反馈关系 |
|   |   |   |   |

代表性来源链接（节选，访问以官方最新版本为准）：

- Gartner GenAI 采用： [gartner.com](https://www.gartner.com/en/newsroom/press-releases/2023-10-11-gartner-says-more-than-80-percent-of-enterprises-will-have-used-generative-ai-apis-or-deployed-generative-ai-enabled-applications-by-2026)
- McKinsey State of AI： [mckinsey.com](https://www.mckinsey.com/capabilities/quantumblack/our-insights/the-state-of-ai)
- BCG AI Value Gap： [bcg.com](https://www.bcg.com/publications/2025/from-potential-to-profit-with-genai)
- IBM Data Breach： [ibm.com](https://www.ibm.com/reports/data-breach)
- OpenAI Deployment Company： [openai.com](https://openai.com/index/openai-deployment-company/)
- Anthropic Partner Network： [anthropic.com](https://www.anthropic.com/news/claude-partner-network)
- Salesforce Agentforce FDE： [salesforce.com](https://engineering.salesforce.com/agentforce-forward-deployed-engineers/)
- Palantir S-1： [sec.gov](https://www.sec.gov/Archives/edgar/data/1321655/000119312520244263/d904406ds1.htm)

## C.2 一线交付方法论与法规依据说明

- **脱敏行业案例与方法论** ：第六章 6.9—6.10 节的"五步交付法""人机协同分层""高风险动作人工复核"以及四个行业类型化案例，系基于一线企业 AI 转型交付实践，按行业类型归纳、脱敏重构后提炼的方法论样本，不指向任何具体企业名称，亦未照搬原始案例文本；其用途是说明 FDE 跨行业可迁移的工作次序与风险边界，而非还原单一项目。
- **信息安全与隐私保护的法规依据（第七章）** ：第七章在讨论数据分级、访问控制、跨境传输、个人信息处理与关键信息基础设施保护时，所引述的法律、行政法规、国家标准与部门规章包括《网络安全法》《数据安全法》《个人信息保护法》、等保 2.0（GB/T 22239-2019）、数据分类分级规则（GB/T 43697）、个人信息安全规范（GB/T 35273）、《生成式人工智能服务管理暂行办法》《数据出境安全评估办法》《个人信息出境标准合同办法》《促进和规范数据跨境流动规定》《关键信息基础设施安全保护条例》《网络安全审查办法》等；涉外场景另参考 GDPR 相关要求。上述条文仅作合规框架讨论，具体适用以官方发布文本及监管解释为准。

---
