'use strict';

/**
 * ingest-guard 单元验证。
 *
 * 关键是要做「变异测试」：既验证它拦得住扫描件（真阳性），
 * 也验证它不误伤正常资料（真阴性）——后者更重要，
 * 一个把正常资料全部拒收的守卫比没有守卫更糟。
 *
 * 用法：node scripts/test-guard.js
 */

const path = require('path');
const fs = require('fs');
const guard = require('../server/ingest-guard');

const PROJECT = path.resolve(__dirname, '..');

let pass = 0;
const fails = [];

function check(name, actual, expected) {
  if (actual === expected) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fails.push(name);
    console.log(`  ✗ ${name} —— 期望 ${expected}，实际 ${actual}`);
  }
}

console.log('ingest-guard 验证\n');

/* ---------- 1. 真阳性：扫描件只抓到页眉 ---------- */

console.log('[真阳性] 应当被拦下');
{
  // 复刻《建设工程监理规范》那份扫描件的真实形态：
  // 63 页，每页页眉都是同一句，正文一个字都没有。
  const lines = [];
  for (let i = 0; i < 63; i++) lines.push('住房城乡建设部信息公开浏览专用');
  const scanned = lines.join('\n');
  const r = guard.inspectExtractedText(scanned);
  check('63 行同一句页眉 => scanned=true', r.scanned, true);
  check('给出处置建议', r.suggestion.length > 10, true);
  check('记录重复行占比', r.detail.topLineRatio >= 0.9, true);

  const r2 = guard.inspectExtractedText('');
  check('空文本 => scanned=true', r2.scanned, true);
}

{
  // 页眉 + 页脚夹杂少量噪声，仍然应被识别
  const lines = [];
  for (let i = 0; i < 40; i++) {
    lines.push('住房城乡建设部信息公开浏览专用');
    lines.push(String(i + 1));
  }
  const r = guard.inspectExtractedText(lines.join('\n'));
  check('页眉+页码混排 => scanned=true', r.scanned, true);
}

{
  // 躲法一：文字层把 63 个页眉合并成**一整行**（无换行符）
  // 行级重复率恒为 1/1，看起来"不重复"，必须靠短语重复抓出来
  const oneLongLine = '住房城乡建设部信息公开浏览专用'.repeat(63);
  const r = guard.inspectExtractedText(oneLongLine);
  check('页眉全部合并成一行 => scanned=true（行级去重抓不到，靠短语重复）', r.scanned, true);
  check('  且识别出的短语正确', r.detail.topPhrase.includes('住房城乡建设部'), true);
}

{
  // 躲法二：每行长度都不同（页眉里带页码），行文本不完全相同
  const lines = [];
  for (let i = 1; i <= 63; i++) lines.push(`住房城乡建设部信息公开浏览专用第${i}页`);
  const r = guard.inspectExtractedText(lines.join('\n'));
  check('每行带不同页码 => scanned=true', r.scanned, true);
}

/* ---------- 2. 真阴性：正常资料不能被误伤 ---------- */

console.log('\n[真阴性] 必须放行');
{
  const r = guard.inspectExtractedText('这是一份很短但正常的资料。用于测试单行文本不应被拦下。');
  check('单行短文本 => scanned=false', r.scanned, false);
}

{
  // 极端情形：一份资料正文只有两行且内容相同（比如一条提示重复两遍），
  // 行数不足 MIN_LINES_FOR_REPEAT，不应判为扫描件
  const r = guard.inspectExtractedText('注意事项：请勿泄露口令。\n注意事项：请勿泄露口令。');
  check('仅 2 行重复文本 => scanned=false（行数不足以判定）', r.scanned, false);
}

{
  // 正常长文：多行、内容各不相同（真实规范/资料的形态）。
  //
  // 注意构造方式：**不能靠"同一句话 + 变化的数字"来造差异** ——
  // 那样文字本身就是重复的（同一短语会出现几十次），被判为噪声是对的。
  // 真实资料的特点是"每一条的表述都不一样"，所以这里逐句独立撰写。
  const sentences = [
    '总监理工程师应当由具有相应资格的人员担任，并在任命前完成必要的岗前培训与考核。',
    '监理实施细则应在相应工程施工开始前编制完成，并经总监理工程师审批后报送建设单位。',
    '项目监理机构收到施工单位报送的施工组织设计后，应在约定时间内提出审查意见。',
    '专业监理工程师应对进场的工程材料进行检验，未经检验或检验不合格的不得用于工程。',
    '监理人员发现施工存在质量隐患的，应当及时下达监理通知单，要求施工单位限期整改。',
    '隐蔽工程在隐蔽前应由施工单位通知有关单位进行验收，并形成验收文件后方可继续施工。',
    '工程暂停施工的原因消除后，总监理工程师应签署复工令并报建设单位备案存档备查。',
    '监理月报应如实反映工程进展、质量状况、安全生产情况以及本月完成的主要监理工作。',
    '工程造价控制应从设计阶段开始介入，通过对设计方案的技术经济比较实现主动控制目标。',
    '工程进度控制应以合同工期为目标，通过编制总进度计划并逐级分解来实施动态管理。',
    '安全生产管理的监理工作包括审查专项施工方案，并对危险性较大的分部分项工程实施旁站。',
    '施工合同争议处理中，总监理工程师应先行调解；调解不成的，按合同约定的方式解决。',
    '监理文件资料应按单位工程分类整理，采用统一编号，并由专人负责收集与归档保管。',
    '设备监造应编制监造计划，对关键工序与主要零部件的制造过程实施见证、巡检或停止点检查。',
    '相关服务包括勘察设计阶段、保修阶段等非施工阶段的咨询服务，其内容由合同约定明确。',
    '工程竣工预验收由总监理工程师组织，验收合格后应编写工程质量评估报告并提交建设单位。'
  ];
  const lines = [];
  for (let i = 0; i < 80; i++) {
    lines.push(`第 ${i + 1} 条 ${sentences[i % sentences.length]}`);
  }
  const r = guard.inspectExtractedText(lines.join('\n'));
  if (r.scanned) {
    console.log(`      （诊断：短语「${r.detail.topPhrase}」出现 ${r.detail.topPhraseCount} 次，块长 ${r.detail.topPhraseBlockChars}，独立内容 ${r.detail.independentChars} 字）`);
  }
  check('80 行真实撰写的条文 => scanned=false', r.scanned, false);
}

{
  // 表格型资料：行数多、每行都短，但内容各不相同 —— 不能被误伤
  const items = ['土方开挖', '混凝土浇筑', '钢筋绑扎', '防水施工', '钢结构安装', '幕墙工程', '机电安装', '装饰装修'];
  const lines = [];
  for (let i = 0; i < 30; i++) lines.push(`序号${i + 1} ${items[i % items.length]} 单位 m2 数量 ${i * 3 + 7} 备注 见附表${i % 5}`);
  const r = guard.inspectExtractedText(lines.join('\n'));
  check('30 行各不相同的表格 => scanned=false', r.scanned, false);
}

{
  // 真正的重复行：整行一模一样地重复 30 遍，无任何独立信息
  const lines = [];
  for (let i = 0; i < 30; i++) lines.push('项目名称 单位 数量 备注见附表');
  const r = guard.inspectExtractedText(lines.join('\n'));
  check('30 行完全相同的行 => scanned=true（确实无信息量）', r.scanned, true);
}

/* ---------- 3. 用真实项目资料回归 ---------- */

console.log('\n[真实资料回归] knowledge/ 下的种子资料必须全部放行');
{
  const kbDir = path.join(PROJECT, 'knowledge');
  if (fs.existsSync(kbDir)) {
    const files = fs.readdirSync(kbDir).filter((f) => /\.(md|txt)$/i.test(f));
    if (files.length === 0) {
      console.log('  （knowledge/ 下没有 md/txt 文件，跳过）');
    }
    for (const file of files) {
      const text = fs.readFileSync(path.join(kbDir, file), 'utf8');
      const r = guard.inspectExtractedText(text);
      check(`${file} => scanned=false`, r.scanned, false);
    }
  } else {
    console.log('  （knowledge/ 不存在，跳过）');
  }
}

console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) {
  console.log('\n失败项：');
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
