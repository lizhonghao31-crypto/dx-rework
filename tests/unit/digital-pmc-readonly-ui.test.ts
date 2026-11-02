import {afterEach, describe, expect, it, vi} from 'vitest';
import {createElement, type ComponentType} from 'react';
import type * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {digitalSlaDefaults} from '@dx-rework/contracts/digital-sla';
import {DEVELOPMENT_CYCLE_DEFAULTS} from '@dx-rework/contracts/digital-development-technical';
import {canReadAllDigitalPatternTasks, canReadDigitalProductionSettings, pmcPatternTaskReadOnly, type DigitalAccessOptions} from '../../apps/web/src/digital-production-access-panel.js';
import * as slaEditor from '../../apps/web/src/sla-standard-editor.js';
import * as developmentCycle from '../../apps/web/src/development-cycle-settings.js';
import * as seriesSettings from '../../apps/web/src/series-settings.js';
import {CockpitProductionSettings} from '../../apps/web/src/cockpit-production-settings.js';

// Seed only the loaded GET state. The real components render all permission-
// dependent controls; effects and network requests do not run during SSR.
const state = vi.hoisted(() => ({seeds: [] as unknown[]}));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof React>();
  return {...actual, useState: (initial: unknown) => actual.useState(state.seeds.length ? state.seeds.shift() : initial)};
});
vi.mock('../../apps/web/src/sla-order-application-panel.js', () => ({SlaOrderApplicationPanel: () => 'TEST existing order application'}));
vi.mock('../../apps/web/src/short-lead-panel.js', () => ({ShortLeadPanel: () => null}));

afterEach(() => {state.seeds = []; vi.restoreAllMocks();});
function access(roles: string[], manage = false): DigitalAccessOptions {
  return {roles, manage, customers: false, approveDelivery: false, create: false, actorId: 'TEST-PMC'};
}
function renderLoaded(component: ComponentType<{readOnly?: boolean}>, seeds: unknown[], readOnly: boolean) {
  state.seeds = [...seeds];
  try {return renderToStaticMarkup(createElement(component, {readOnly}));}
  finally {state.seeds = [];}
}
const sla = {version: 2, scope: 'new_orders' as const, values: digitalSlaDefaults(), history: [{version: 2, reason: 'TEST current'}, {version: 1, reason: 'TEST historical'}]};
const cycle = {version: 2, scope: 'new_sources' as const, values: {...DEVELOPMENT_CYCLE_DEFAULTS}, history: sla.history};

describe('PMC digital read entry preserves original write flags', () => {
  it.each([
    {roles: ['pmc'], manage: false, read: true},
    {roles: ['pmc', 'finance'], manage: false, read: true},
    {roles: ['pmc', 'production_management'], manage: true, read: true},
    {roles: ['owner_group'], manage: true, read: true},
    {roles: ['root_superuser'], manage: true, read: true},
    {roles: ['pattern_room_worker'], manage: false, read: false},
    {roles: ['quality_control'], manage: false, read: false},
  ])('reads settings for $roles without synthesizing manage', ({roles, manage, read}) => {
    const options = access(roles, manage), before = structuredClone(options);
    expect(canReadDigitalProductionSettings(options)).toBe(read);
    expect(options).toEqual(before);
    expect(options.manage).toBe(manage);
  });

  it.each([
    {roles: ['pmc'], expected: true},
    {roles: ['production_management'], expected: true},
    {roles: ['pattern_room_supervisor'], expected: true},
    {roles: ['development_clerk'], expected: true},
    {roles: ['pattern_room_worker'], expected: false},
    {roles: ['quality_control'], expected: false},
  ])('keeps all-progress board scope separate for $roles', ({roles, expected}) => {
    expect(canReadAllDigitalPatternTasks(roles)).toBe(expected);
  });

  it('does not treat summary mode as execution authority and preserves other original roles', () => {
    const read = {instanceId: 'TEST-task', owner: {id: 'TEST-PMC', name: 'TEST assigned'}, records: [{domain: 'task', id: 'TEST-task', mode: 'read' as const, url: null, version: null, lineId: null}]};
    const handle = {records: [{...read.records[0]!, mode: 'handle' as const}]};
    expect(pmcPatternTaskReadOnly(access(['pmc']), read)).toBe(true);
    expect(pmcPatternTaskReadOnly(access(['pmc', 'finance']), read)).toBe(true);
    expect(pmcPatternTaskReadOnly(access(['pmc']), {...read, ...handle})).toBe(true);
    expect(pmcPatternTaskReadOnly(access(['pmc', 'pattern_room_worker']), read)).toBe(false);
    expect(pmcPatternTaskReadOnly(access(['pmc', 'production_management'], true), read)).toBe(false);
    expect(pmcPatternTaskReadOnly({...access(['pmc', 'sample_designer']), create: true}, read)).toBe(false);
    expect(pmcPatternTaskReadOnly(access(['pmc', 'order_merchandiser']), read)).toBe(false);
    expect(pmcPatternTaskReadOnly(access(['pattern_room_worker']), read)).toBe(false);
  });

  it.each([
    {roles: ['pmc'], owner: 'TEST-PMC', readOnly: true},
    {roles: ['pmc', 'pattern_room_worker'], owner: 'TEST-PMC', readOnly: false},
    {roles: ['pmc', 'pattern_room_worker'], owner: 'TEST-other', readOnly: true},
    {roles: ['pmc', 'pattern_room_worker'], owner: null, readOnly: true},
    {roles: ['pmc', 'pattern_room_tail_inspector'], owner: 'TEST-PMC', readOnly: false},
    {roles: ['pmc', 'pattern_room_tail_inspector'], owner: 'TEST-other', readOnly: true},
    {roles: ['pmc', 'finance'], owner: 'TEST-PMC', readOnly: true},
    {roles: ['pmc', 'quality_control'], owner: 'TEST-PMC', readOnly: true},
    {roles: ['pmc', 'worker'], owner: 'TEST-PMC', readOnly: true},
  ])('preserves only original own board-task navigation from a read summary for $roles, owner=$owner', ({roles, owner, readOnly}) => {
    const summary = {instanceId: 'TEST-task', owner: owner ? {id: owner, name: 'TEST assigned'} : null,
      records: [{domain: 'task', id: 'TEST-task', mode: 'read' as const, url: null, version: null, lineId: null}]};
    const before = structuredClone(summary);
    expect(pmcPatternTaskReadOnly(access(roles), summary)).toBe(readOnly);
    expect(summary).toEqual(before);
    expect(summary.records[0]!.mode).toBe('read');
  });

  it.each([
    {taskId: 'TEST-task', assigneeId: 'TEST-PMC', requiredRole: 'pattern_room_worker', canExecute: true, readOnly: false},
    {taskId: 'TEST-task', assigneeId: 'TEST-PMC', requiredRole: 'pattern_room_worker', canExecute: false, readOnly: true},
    {taskId: 'TEST-task', assigneeId: 'TEST-other', requiredRole: 'pattern_room_worker', canExecute: true, readOnly: true},
    {taskId: 'TEST-task', assigneeId: 'TEST-PMC', requiredRole: 'pattern_room_tail_inspector', canExecute: true, readOnly: true},
    {taskId: 'TEST-other', assigneeId: 'TEST-PMC', requiredRole: 'pattern_room_worker', canExecute: true, readOnly: true},
  ])('uses a loaded task DTO without granting sibling scope: $taskId/$assigneeId/$requiredRole/$canExecute', ({readOnly, ...task}) => {
    const node = {instanceId: 'TEST-task', owner: {id: 'TEST-PMC', name: 'TEST assigned'}};
    expect(pmcPatternTaskReadOnly(access(['pmc', 'pattern_room_worker']), node, task)).toBe(readOnly);
    expect(pmcPatternTaskReadOnly(access(['pmc']), node, task)).toBe(true);
  });

  it.each([
    {roles: ['pmc'], manage: false, visible: true, readOnly: true},
    {roles: ['pmc', 'production_management'], manage: true, visible: true, readOnly: false},
    {roles: ['production_management'], manage: true, visible: true, readOnly: false},
    {roles: ['quality_control'], manage: false, visible: false, readOnly: true},
  ])('settings shell passes independent readOnly for $roles', ({roles, manage, visible, readOnly}) => {
    vi.spyOn(slaEditor, 'SlaStandardEditor').mockImplementation((props = {}) => createElement('span', {'data-settings-editor': 'sla', 'data-readonly': String(props.readOnly)}));
    vi.spyOn(developmentCycle, 'DevelopmentCycleSettings').mockImplementation((props = {}) => createElement('span', {'data-settings-editor': 'development', 'data-readonly': String(props.readOnly)}));
    vi.spyOn(seriesSettings, 'SeriesSettings').mockImplementation((props = {}) => createElement('span', {'data-settings-editor': 'series', 'data-readonly': String(props.readOnly)}));
    state.seeds = [access(roles, manage), ''];
    const html = renderToStaticMarkup(createElement(CockpitProductionSettings));
    expect(html.includes('data-settings-editor')).toBe(visible);
    if (visible) {
      expect(html.match(new RegExp(`data-readonly="${readOnly}"`, 'g'))).toHaveLength(3);
      expect(html).not.toContain('当前岗位无权访问');
    } else expect(html).toContain('当前岗位无权访问生产管理设置');
  });
});

describe('loaded settings render values and history without PMC write controls', () => {
  it('renders SLA values, current/history reads, and no draft, preview, publish or existing-order application', () => {
    const html = renderLoaded(slaEditor.SlaStandardEditor, [sla, sla.values], true);
    expect(html).toContain('读取现行标准');
    expect(html).toContain('查看历史标准');
    expect(html).toContain('TEST historical');
    expect(html).toContain('提前 10 天');
    for (const text of ['type="number"', 'type="checkbox"', '调整原因', '复制到草稿', '预览新单标准', '确认发布新单标准', 'TEST existing order application']) expect(html).not.toContain(text);
  });

  it('keeps original SLA editing and order application for an authorized manager', () => {
    const html = renderLoaded(slaEditor.SlaStandardEditor, [sla, sla.values], false);
    expect(html).toContain('type="number"');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('复制该版本到草稿');
    expect(html).toContain('预览新单标准');
    expect(html).toContain('TEST existing order application');
  });

  it('renders development-cycle values and selectable history without preview or publish', () => {
    const html = renderLoaded(developmentCycle.DevelopmentCycleSettings, [cycle, cycle.values], true);
    expect(html).toContain('正常内部周期（自然日）');
    expect(html).toContain('选择历史开发周期标准');
    expect(html).toContain('TEST historical');
    expect(html).toContain('重新读取开发周期标准');
    for (const text of ['type="number"', '调整原因', '预览开发周期变化', '确认发布新开发标准', '核对并重试原发布']) expect(html).not.toContain(text);
  });

  it('retains the original development-cycle editor for an authorized manager', () => {
    const html = renderLoaded(developmentCycle.DevelopmentCycleSettings, [cycle, cycle.values], false);
    expect(html).toContain('type="number"');
    expect(html).toContain('调整原因');
    expect(html).toContain('预览开发周期变化');
  });

  it('renders current series defaults and reason without a publication form', () => {
    const rows = [{customerCode: 'TEST-PD', version: 3, monthOffset: -2, shippingDay: 15, reason: 'TEST adopted default'}];
    const html = renderLoaded(seriesSettings.SeriesSettings, [rows], true);
    expect(html).toContain('TEST-PD');
    expect(html).toContain('TEST adopted default');
    expect(html).toContain('上架月-2个月 / 15日');
    for (const text of ['<input', '<textarea', '发布新默认']) expect(html).not.toContain(text);
    const manager = renderLoaded(seriesSettings.SeriesSettings, [rows], false);
    expect(manager).toContain('系列月份偏移');
    expect(manager).toContain('发布新默认');
  });
});
