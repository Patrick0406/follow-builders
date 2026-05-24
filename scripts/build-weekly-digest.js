#!/usr/bin/env node

// Build a polished weekly digest from the Follow Builders feed using OpenAI.
// Intended for GitHub Actions: prepare-digest.js supplies current content,
// this script asks the model to turn it into a readable email.

import { spawnSync } from 'child_process';

const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const MAX_TWEETS_PER_BUILDER = Number(process.env.MAX_TWEETS_PER_BUILDER || 5);
const MAX_PODCAST_TRANSCRIPT_CHARS = Number(process.env.MAX_PODCAST_TRANSCRIPT_CHARS || 12000);

function runPrepareDigest() {
  const result = spawnSync(process.execPath, ['prepare-digest.js'], {
    cwd: new URL('.', import.meta.url).pathname,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'prepare-digest.js failed');
  }

  return JSON.parse(result.stdout);
}

function compactDigestPayload(payload) {
  return {
    generatedAt: payload.generatedAt,
    config: payload.config,
    stats: payload.stats,
    errors: payload.errors,
    podcasts: (payload.podcasts || []).map((episode) => ({
      source: episode.source,
      name: episode.name,
      title: episode.title,
      url: episode.url,
      publishedAt: episode.publishedAt,
      transcriptExcerpt: (episode.transcript || '').slice(0, MAX_PODCAST_TRANSCRIPT_CHARS)
    })),
    x: (payload.x || []).map((builder) => ({
      source: builder.source,
      name: builder.name,
      handle: builder.handle,
      bio: builder.bio,
      tweets: (builder.tweets || [])
        .slice()
        .sort((a, b) => (b.likes || 0) - (a.likes || 0))
        .slice(0, MAX_TWEETS_PER_BUILDER)
        .map((tweet) => ({
          text: tweet.text,
          createdAt: tweet.createdAt,
          url: tweet.url,
          likes: tweet.likes,
          retweets: tweet.retweets,
          replies: tweet.replies
        }))
    })),
    blogs: (payload.blogs || []).map((post) => ({
      source: post.source,
      title: post.title,
      url: post.url,
      publishedAt: post.publishedAt,
      excerpt: post.content || post.text || post.summary || post.description || ''
    }))
  };
}

function outputTextFromResponse(response) {
  if (response.output_text) return response.output_text;

  const chunks = [];
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (content.type === 'output_text' && content.text) chunks.push(content.text);
      if (content.type === 'text' && content.text) chunks.push(content.text);
    }
  }
  return chunks.join('\n').trim();
}

async function createDigest(payload) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required');
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      instructions: [
        'You write concise Chinese weekly briefings for a technical founder/operator.',
        'Use the provided AI builder feed only. Do not invent facts.',
        'Write in simplified Chinese. Keep English product/company names as-is.',
        'Prioritize actionable insights, product signals, technical shifts, and links worth opening.',
        'Avoid fluff. Every bullet should teach the reader something useful.'
      ].join('\n'),
      input: [
        '请把下面的 Follow Builders 数据整理成一封中文周报邮件正文。',
        '',
        '格式要求：',
        '- 标题：AI Builders 周报 - YYYY-MM-DD',
        '- 开头用 3-5 条“本周最值得关注”。',
        '- 然后按「产品与工具」「技术与模型」「创业与组织」「值得打开的链接」分组。',
        '- 每条保留来源姓名或节目名，并附原链接。',
        '- 如果某一组信息不足，可以省略该组。',
        '- 结尾给出 3 条“下周可行动建议”。',
        '',
        JSON.stringify(payload, null, 2)
      ].join('\n'),
      temperature: 0.4,
      max_output_tokens: 5000,
      store: false
    })
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${errorBody}`);
  }

  const body = await response.json();
  const text = outputTextFromResponse(body);
  if (!text) throw new Error('OpenAI response did not contain text output');
  return text;
}

async function main() {
  const prepared = runPrepareDigest();
  const compact = compactDigestPayload(prepared);
  const digest = await createDigest(compact);
  console.log(digest);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
