/**
 * QoderCLI target。
 *
 * 写入 MCP server 条目到 `~/.qoder/settings.json`（global）或
 * `<cwd>/.qoder/settings.json`（local）的 `mcpServers.codegraph` 键下。
 *
 * QoderCLI 无 permissions 概念，不写 instructions 文件。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type {
  AgentTarget,
  DetectionResult,
  InstallOptions,
  Location,
  WriteResult,
} from './types';
import {
  getMcpServerConfig,
  jsonDeepEqual,
  readJsonFile,
  writeJsonFile,
} from './shared';

function configDir(loc: Location): string {
  return loc === 'global'
    ? path.join(os.homedir(), '.qoder')
    : path.join(process.cwd(), '.qoder');
}

function settingsJsonPath(loc: Location): string {
  return path.join(configDir(loc), 'settings.json');
}

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = settingsJsonPath(loc);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const existing = readJsonFile(file);
  const before = existing.mcpServers?.codegraph;
  const after = getMcpServerConfig();

  if (jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }
  const action: 'created' | 'updated' =
    before ? 'updated' : (fs.existsSync(file) ? 'updated' : 'created');
  if (!existing.mcpServers) existing.mcpServers = {};
  existing.mcpServers.codegraph = after;
  writeJsonFile(file, existing);
  return { path: file, action };
}

class QoderTarget implements AgentTarget {
  readonly id = 'qoder' as const;
  readonly displayName = 'Qoder CLI';
  readonly docsUrl = 'https://docs.qoder.com/';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const dir = configDir(loc);
    const file = settingsJsonPath(loc);
    const installed = fs.existsSync(dir);
    const config = installed ? readJsonFile(file) : {};
    const alreadyConfigured = !!config.mcpServers?.codegraph;
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    return { files: [writeMcpEntry(loc)] };
  }

  uninstall(loc: Location): WriteResult {
    const file = settingsJsonPath(loc);
    const config = readJsonFile(file);
    if (config.mcpServers?.codegraph) {
      delete config.mcpServers.codegraph;
      if (Object.keys(config.mcpServers).length === 0) {
        delete config.mcpServers;
      }
      writeJsonFile(file, config);
      return { files: [{ path: file, action: 'removed' }] };
    }
    return { files: [{ path: file, action: 'not-found' }] };
  }

  printConfig(loc: Location): string {
    const target = settingsJsonPath(loc);
    const snippet = JSON.stringify({ mcpServers: { codegraph: getMcpServerConfig() } }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [settingsJsonPath(loc)];
  }
}

export const qoderTarget: AgentTarget = new QoderTarget();
