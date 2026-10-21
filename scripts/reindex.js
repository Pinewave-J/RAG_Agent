#!/usr/bin/env node
'use strict';

/**
 * 命令行重建索引。
 * 适用场景：直接往服务器的 knowledge/ 目录拷了文件，又不想打开浏览器点击按钮。
 *
 * 用法：
 *   npm run reindex              # 重建索引，并尝试生成向量
 *   npm run reindex -- --no-vec  # 重建索引，跳过向量化
 */

const { ensureDirs, config } = require('../server/config');
const indexer = require('../server/indexer');
const store = require('../server/store');

async function main() {
  ensureDirs();

  const withVectors = !process.argv.includes('--no-vec');

  console.log('== 开始重建索引 ==');
  console.log(`知识库目录：${config.paths.kb}`);
  console.log(`上传目录  ：${config.paths.uploads}`);
  console.log(`向量化    ：${withVectors ? '启用（若已配置向量模型）' : '跳过'}`);
  console.log('');

  const result = await indexer.reindexAll({
    withVectors,
    onProgress: (done, total) => {
      process.stdout.write(`\r  向量化进度 ${done}/${total}`);
    }
  });

  console.log('');
  console.log('== 完成 ==');
  console.log(`文档数：${result.documents}`);
  console.log(`片段数：${result.chunks}`);

  if (result.vector && result.vector.skipped) {
    console.log(`向量  ：已跳过（${result.vector.reason}）`);
  } else if (result.vector && result.vector.ok) {
    console.log(`向量  ：${result.vector.embedded} 个片段，维度 ${result.vector.dim}，模型 ${result.vector.model}`);
  } else if (result.vector) {
    console.log(`向量  ：失败 - ${result.vector.error}`);
  }

  if (result.failures.length) {
    console.log('');
    console.log(`以下 ${result.failures.length} 个文件未能入库：`);
    for (const f of result.failures) {
      console.log(`  - ${f.file}：${f.reason}`);
    }
  }

  const stats = store.stats();
  console.log('');
  console.log(`索引已保存：${stats.characters} 字，词表 ${stats.vocabulary} 项，更新于 ${stats.updatedAt}`);
}

main().catch((err) => {
  console.error('重建失败：', err);
  process.exit(1);
});
