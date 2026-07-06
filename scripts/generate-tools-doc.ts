import { ToolRegistry } from '../src/tools/registry.js';
import { registerBuiltinTools } from '../src/tools/register.js';
import { EnvSchema } from '../src/config/env.js';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { format, resolveConfig } from 'prettier';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Zod v4 exposes its internal schema kind as `_def.type` (Zod v3 used `_def.typeName`).
function getFriendlyZodType(schema: z.ZodTypeAny): string {
  const def = schema._def as Record<string, any>;
  const typeName = def?.type;
  if (typeName === 'object') return 'object';
  if (typeName === 'array') return `${getFriendlyZodType(def.element)}[]`;
  if (typeName === 'string') return 'string';
  if (typeName === 'number') return 'number';
  if (typeName === 'boolean') return 'boolean';
  if (typeName === 'enum') {
    const values = def.entries ? Object.values(def.entries) : (def.values ?? []);
    return (values as string[]).map((v) => `'${v}'`).join(' | ');
  }
  if (typeName === 'optional') return `${getFriendlyZodType(def.innerType)} (optional)`;
  if (typeName === 'nullable') return `${getFriendlyZodType(def.innerType)} | null`;
  if (typeName === 'union') {
    const options: z.ZodTypeAny[] = def.options ?? [];
    return options.map((opt) => getFriendlyZodType(opt)).join(' | ');
  }
  if (typeName === 'literal') {
    const values = def.values ?? [def.value];
    return (values as unknown[]).map((v) => `'${String(v)}'`).join(' | ');
  }
  if (typeName === 'pipe') return getFriendlyZodType(def.in);
  if (typeName === 'record') return `Record<string, ${getFriendlyZodType(def.valueType)}>`;
  if (typeName === 'default') return getFriendlyZodType(def.innerType);
  return 'any';
}

function pushParamsTable(md: string[], shape: Record<string, z.ZodTypeAny>): void {
  const keys = Object.keys(shape);
  if (keys.length === 0) {
    md.push('No parameters required.', '');
    return;
  }
  md.push('| Parameter | Type | Required | Description |');
  md.push('|-----------|------|----------|-------------|');
  for (const [key, prop] of Object.entries(shape)) {
    const schema = prop as z.ZodTypeAny;
    const isOptional = schema instanceof z.ZodOptional || schema._def?.type === 'optional';
    const typeName = getFriendlyZodType(schema);
    const desc = schema.description ?? '';
    md.push(`| \`${key}\` | \`${typeName}\` | ${isOptional ? 'No' : 'Yes'} | ${desc} |`);
  }
  md.push('');
}

function generateMarkdown(): string {
  const registry = new ToolRegistry();
  const config = EnvSchema.parse({
    NODE_ENV: 'production',
    LOG_LEVEL: 'silent',
    TOOL_PROFILE: 'dev', // register all dev tools for docs
  });

  registerBuiltinTools(registry, config);

  const tools = registry.getAllTools().sort((a, b) => a.name.localeCompare(b.name));

  const md: string[] = [
    '# MCP Tools Reference',
    '',
    'This page details all available Model Context Protocol (MCP) tools exposed by `easyeda-mcp-pro`.',
    'These tools are profile-gated. Set the `TOOL_PROFILE` environment variable to enable them.',
    '',
    '## Summary of Tools',
    '',
    '| Tool Name | Profile | Risk | Description |',
    '|-----------|---------|------|-------------|',
  ];

  for (const tool of tools) {
    md.push(`| \`${tool.name}\` | \`${tool.profile}\` | \`${tool.risk}\` | ${tool.description} |`);
  }

  md.push('', '---', '');

  for (const tool of tools) {
    md.push(`## \`${tool.name}\``, '');
    md.push(`**Profile:** \`${tool.profile}\` | **Risk Level:** \`${tool.risk}\``, '');
    md.push(`> ${tool.description}`, '');
    md.push('');

    // Input parameters
    md.push('### Input Parameters', '');
    if (tool.inputSchema instanceof z.ZodObject) {
      pushParamsTable(md, tool.inputSchema.shape);
    } else if (tool.inputSchema instanceof z.ZodDiscriminatedUnion) {
      md.push('This tool accepts one of several shapes, selected by the `topic` field:', '');
      for (const variant of tool.inputSchema._def.options as z.ZodObject<any>[]) {
        const discriminatorEntry = Object.entries(variant.shape).find(
          ([, prop]) => (prop as z.ZodTypeAny)._def.type === 'literal',
        );
        const label = discriminatorEntry
          ? getFriendlyZodType(discriminatorEntry[1] as z.ZodTypeAny)
          : 'variant';
        md.push(`**When \`topic\` is ${label}:**`, '');
        pushParamsTable(md, variant.shape);
      }
    } else {
      md.push('No parameters required.', '');
    }

    md.push('### Output Format', '');
    md.push('Returns a JSON object matching the schema:', '');
    md.push('```ts');
    if (tool.outputSchema instanceof z.ZodObject) {
      const shape = tool.outputSchema.shape;
      const props = Object.entries(shape).map(([key, prop]) => {
        const schema = prop as z.ZodTypeAny;
        const typeName = getFriendlyZodType(schema);
        return `  ${key}: ${typeName};`;
      });
      md.push('{\n' + props.join('\n') + '\n}');
    } else {
      md.push(getFriendlyZodType(tool.outputSchema));
    }
    md.push('```', '');
    md.push('---', '');
  }

  return md.join('\n');
}

async function main() {
  const destDir = join(__dirname, '..', 'docs', 'reference');
  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true });
  }

  const destPath = join(destDir, 'tools.md');
  // Without the project's .prettierrc, prettier's embedded-code formatter (for the
  // fenced ```ts blocks) falls back to its own defaults (double quotes) instead of this
  // repo's singleQuote:true — resolveConfig() picks that up explicitly rather than
  // relying on a subsequent `prettier --write` pass to reconcile the mismatch.
  const projectConfig = (await resolveConfig(destPath)) ?? {};
  const content = await format(generateMarkdown(), { ...projectConfig, parser: 'markdown' });
  writeFileSync(destPath, content, 'utf8');
  console.log('Successfully generated docs/reference/tools.md');
}

void main();
