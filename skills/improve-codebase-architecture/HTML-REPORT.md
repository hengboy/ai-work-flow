# HTML 报告格式

架构评审被渲染为一个独立的 HTML 文件，位于操作系统的临时目录中。Tailwind 和 Mermaid 都来自 CDN。Mermaid 能够可靠地处理图形化的图表；而更具编辑性的视觉效果（质量图、剖面图）则由手写的 div 和内联 SVG 来实现。将两者结合使用——不要完全依赖 Mermaid，否则会显得过于通用。

## 模板

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Architecture review — {{repo name}}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script type="module">
      import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
      mermaid.initialize({
        startOnLoad: true,
        theme: "neutral",
        securityLevel: "loose",
      });
    </script>
    <style>
      /* small custom layer for things Tailwind doesn't cover cleanly:
         dashed seam lines, hand-drawn-feeling arrow heads, etc. */
      .seam {
        stroke-dasharray: 4 4;
      }
      .leak {
        stroke: #dc2626;
      }
      .deep {
        background: linear-gradient(135deg, #0f172a, #1e293b);
      }
    </style>
  </head>
  <body class="bg-stone-50 text-slate-900 font-sans">
    <main class="max-w-5xl mx-auto px-6 py-12 space-y-12">
      <header>...</header>
      <section id="candidates" class="space-y-10">...</section>
      <section id="top-recommendation">...</section>
    </main>
  </body>
</html>
```

## 页眉

包含仓库名称、日期以及一个简洁的图例：实心方框表示模块，虚线表示接缝，红色箭头表示泄漏，加粗的深色方框表示深度模块。不设导语段落，直接进入候选方案部分。

## 候选方案卡片

图表是重点。文字描述简练、平实，并直接使用 `/codebase-design` 技能中的术语，不做额外修饰。

每个候选方案对应一个 `<article>`：

- **标题** — 简短，命名深化目标（如：“缩减订单录入流水线”）。
- **标签行** — 包含推荐强度（“强烈推荐”用祖母绿，“值得探索”用琥珀色，“推测性”用石板灰），以及依赖分类标签（“在处理中”、“可本地替换”、“端口与适配器”、“模拟”）。
- **文件列表** — 等宽字体，`font-mono text-sm`。
- **前后对比图** — 核心内容。两列并排展示。具体模式见下文。
- **问题** — 一句话，说明痛点。
- **解决方案** — 一句话，说明变化。
- **收益** — 列表项，每条不超过 6 个字。例如：“测试只触达一个接口”，“定价逻辑不再泄漏”，“删除 4 个浅层包装”。
- **ADR 提示**（如适用） — 放置在琥珀色背景的方框中，一行显示。

不设解释性段落。如果图表需要文字才能理解，则应重新绘制图表。

## 图表模式

根据候选方案选择合适的模式，混合使用。不要让所有图表看起来都一样——多样性正是其意义所在。

### Mermaid 图表（用于依赖关系/调用流程）

当重点在于“X 调用 Y，Y 又调用 Z，看看这混乱的局面”时，使用 Mermaid 的 `flowchart` 或 `graph`。将其包裹在 Tailwind 样式的卡片中，避免突兀感。通过 `classDef` 设置泄漏边为红色，深度模块为深色。序列图非常适合展示“之前：6 次往返；之后：1 次”。

```html
<div class="rounded-lg border border-slate-200 bg-white p-4">
  <pre class="mermaid">
    flowchart LR
      A[OrderHandler] --> B[OrderValidator]
      B --> C[OrderRepo]
      C -.leak.-> D[PricingClient]
      classDef leak stroke:#dc2626,stroke-width:2px;
      class C,D leak
  </pre>
</div>
```

### 手工搭建的方框与箭头（当 Mermaid 布局难以满足需求时）

将模块以带有边框和标签的 `<div>` 表示，箭头则使用内联 SVG 的 `<line>` 或 `<path>` 元素，通过相对定位放置于容器之上。当你希望“之后”的图看起来像一个厚边框的深度模块，内部被灰色淡化时，可以采用这种方式——Mermaid 很难渲染出这种层次感。

### 剖面图（适用于分层的浅度结构）

通过堆叠水平带（`h-12 border-l-4`）来展示调用经过的各层。之前：6 层都很薄且无实际功能；之后：1 层变厚，并标注整合后的职责。

### 质量图（适用于“接口与实现同样宽广”的场景）

每个模块用两个矩形表示——一个代表接口面积，另一个代表实现规模。之前：接口矩形几乎与实现矩形一样高（浅）；之后：接口矩形变矮，实现矩形变高（深）。

### 调用图折叠

之前：函数调用树以嵌套方框形式呈现。之后：同一棵树折叠成一个方框，内部的调用以淡色显示。

## 样式指导

- 偏向编辑风格，而非企业仪表盘风格。留白充足。标题可选用衬线字体（`font-serif` 与石色/石板色搭配效果佳）。
- 色彩使用克制：一种强调色（祖母绿或靛蓝），加上红色用于标识泄漏，琥珀色用于警示。
- 图表高度保持在 ~320px 左右，使前后对比图能够并排显示而不需滚动。
- 图表内的模块标签使用 `text-xs uppercase tracking-wider`，使其呈现示意感，而非 UI 风格。
- 脚本仅包含 Tailwind CDN 和 Mermaid ESM 的导入。报告其余部分均为静态内容——无应用代码，除 Mermaid 自身渲染外无交互功能。

## 最优推荐部分

一块较大的卡片。包含候选方案名称、一句话说明理由，以及指向该方案卡片的锚点链接。仅此而已。

## 语气

采用平实、简洁的英语，但架构相关的名词和动词均直接取自 `/codebase-design` 技能。简洁不应成为敷衍的理由。

**必须使用：** 模块、接口、实现、深度、深、浅、接缝、适配器、杠杆、局部性。

**切勿替代：** 组件、服务、单元（代替模块）· API、签名（代替接口）· 边界（代替接缝）· 层、包装（代替模块，当指代模块时）。

**符合风格的表达：**

- “订单录入模块很浅——接口几乎与实现一致。”
- “定价沿着接缝泄漏。”
- “深化：一个接口，一处测试入口。”
- “两个适配器证明了接缝的必要性：生产环境使用 HTTP，测试环境使用内存存储。”

**收益列表** 使用术语库中的词汇表述成果：_“局部性：缺陷集中在一个模块内”_，_“杠杆：一个接口，N 个调用点”_，_“接口缩小，实现吸收了包装层”_。不要写“更易维护”或“代码更整洁”——这些术语不在术语库中，也不应随意引入。

不打太极，不绕圈子，不说“值得注意的是……”。如果某句话可以作为收益点，就把它变成收益点；如果某个收益点可以删减，就删掉它。如果某个术语不在 `/codebase-design` 术语库中，先寻找现有术语，再考虑是否需要新增。
