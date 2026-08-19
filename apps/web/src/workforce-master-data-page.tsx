import { Button, InsetField, StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useMemo, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import { Shell } from "./components.js";
import { promptInApp } from "./system-dialog.js";
import { SystemManagementNavigation } from "./system-management-navigation.js";
import "./workforce-master-data-page.css";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);

type Person = Readonly<{
  personId: string;
  personType: "internal" | "temporary";
  appUserId: string | null;
  displayName: string;
  temporaryCode: string | null;
  temporaryRemark: string | null;
  active: boolean;
  aliases: Array<Readonly<{
    aliasId: string;
    alias: string;
    revokedAt: string | null;
    revokeReason: string | null;
  }>>;
}>;

async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(apiUrl(path), {
    credentials: "include",
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `请求失败（${response.status}）`);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

export function WorkforceMasterDataPage() {
  const [people, setPeople] = useState<Person[]>([]);
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const [aliases, setAliases] = useState("");
  const [temporaryRemark, setTemporaryRemark] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async (): Promise<void> => {
    const rows = await json<Person[]>("master-data/people?includeInactive=true&includeRevokedAliases=true");
    setPeople(rows);
  };

  useEffect(() => {
    void load().catch((error: unknown) => {
      setMessage(error instanceof Error ? error.message : "人员资料加载失败");
    });
  }, []);

  const run = async (work: () => Promise<void>, success: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      await work();
      await load();
      setMessage(success);
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  const createTemporary = async (): Promise<void> => {
    const displayName = name.trim();
    if (!displayName) {
      setMessage("请输入临时工姓名。");
      return;
    }
    const reason = (await promptInApp("请输入建立临时工档案的原因", "返工临时工登记"))?.trim();
    if (!reason) return;
    const aliasValues = [...new Set(
      aliases.split(/[，,]/).map((value) => value.trim()).filter(Boolean),
    )];
    await run(async () => {
      await json("master-data/people", {
        method: "POST",
        body: JSON.stringify({
          personType: "temporary",
          displayName,
          aliases: aliasValues,
          ...(temporaryRemark.trim() ? { temporaryRemark: temporaryRemark.trim() } : {}),
          reason,
        }),
      });
      setName("");
      setAliases("");
      setTemporaryRemark("");
    }, "临时工档案已建立，可在分工上数中直接选择。 ");
  };

  const addAlias = async (person: Person): Promise<void> => {
    const alias = (await promptInApp(`为 ${person.displayName} 新增别名`))?.trim();
    if (!alias) return;
    const reason = (await promptInApp("请输入新增别名原因", "补充现场常用称呼"))?.trim();
    if (!reason) return;
    await run(async () => {
      await json(`master-data/people/${person.personId}/aliases`, {
        method: "POST",
        body: JSON.stringify({ alias, reason }),
      });
    }, "人员别名已新增。 ");
  };

  const revokeAlias = async (aliasId: string): Promise<void> => {
    const reason = (await promptInApp("请输入撤销别名原因"))?.trim();
    if (!reason) return;
    await run(async () => {
      await json(`master-data/people/aliases/${aliasId}`, {
        method: "DELETE",
        body: JSON.stringify({ reason }),
      });
    }, "人员别名已撤销，历史记录保留。 ");
  };

  const deactivateTemporary = async (person: Person): Promise<void> => {
    const reason = (await promptInApp(`请输入停用临时工“${person.displayName}”的原因`))?.trim();
    if (!reason) return;
    await run(async () => {
      await json(`master-data/people/${person.personId}`, {
        method: "DELETE",
        body: JSON.stringify({ reason }),
      });
    }, "临时工档案已停用，历史任务和工资快照不受影响。 ");
  };

  const filteredPeople = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    if (!needle) return people;
    return people.filter((person) => {
      const activeAliases = person.aliases
        .filter((alias) => alias.revokedAt === null)
        .map((alias) => alias.alias)
        .join(" ");
      const type = person.personType === "temporary" ? "临时工" : "内部工人 内部员工";
      const status = person.active ? "有效 可分配" : "停用";
      return `${person.displayName} ${person.temporaryCode ?? ""} ${person.temporaryRemark ?? ""} ${activeAliases} ${type} ${status}`
        .toLocaleLowerCase("zh-CN")
        .includes(needle);
    });
  }, [people, query]);

  const internal = filteredPeople.filter((person) => person.personType === "internal");
  const temporary = filteredPeople.filter((person) => person.personType === "temporary");

  return (
    <Shell active="人员资料">
      <div className="workforce-page">
        <SystemManagementNavigation active="workforce" />
        <header className="page-heading workforce-heading">
          <div>
            <h1>作业人员与临时工</h1>
            <p>内部工人来自权限管理的“工人”角色；临时工在这里单独建档，不提供登录账号。</p>
          </div>
          <StatusBadge tone="info">N04 / N05 人员来源</StatusBadge>
        </header>

        {message ? <Surface className="workforce-message"><p role="status">{message}</p></Surface> : null}

        <Surface className="workforce-create">
          <h2>新增临时工</h2>
          <p>只登记实际作业身份；临时工不上系统，由尾部主管或授权人员代录上数。系统会生成固定临时工编号，避免同名人员的工资记录混淆。</p>
          <div className="workforce-create-grid">
            <label>姓名<input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} /></label>
            <label>区分备注（可选）<input value={temporaryRemark} maxLength={100} placeholder="如：夜班、老张介绍" onChange={(event) => setTemporaryRemark(event.target.value)} /></label>
            <label>别名（可选，用逗号分隔）<input value={aliases} onChange={(event) => setAliases(event.target.value)} /></label>
            <Button variant="primary" disabled={busy || !name.trim()} onClick={() => void createTemporary()}>{busy ? "处理中…" : "建立临时工档案"}</Button>
          </div>
        </Surface>

        <Surface>
          <div className="section-title">
            <div>
              <h2>查找人员</h2>
              <p>按姓名、现场别名、人员类型或状态搜索；业务页面不展示系统内部 ID。</p>
            </div>
            <StatusBadge tone="info">{filteredPeople.length} / {people.length} 人</StatusBadge>
          </div>
          <InsetField
            label="搜索人员"
            type="search"
            value={query}
            placeholder="输入姓名、临时编号、备注、别名、临时工或停用"
            onChange={(event) => setQuery(event.target.value)}
          />
        </Surface>

        <div className="workforce-grid">
          <Surface>
            <h2>内部工人</h2>
            <p>授予“工人”角色后自动进入这里；撤销角色、停用账号或离职后不能再被新分配。</p>
            <div className="workforce-list">
              {internal.length === 0 ? <p>{query.trim() ? "没有匹配的内部工人。" : "暂无已建档内部工人。"}</p> : internal.map((person) => (
                <article key={person.personId}>
                  <div><b>{person.displayName}</b><small>内部员工 · 可登录</small></div>
                  <StatusBadge tone={person.active ? "success" : "warning"}>{person.active ? "档案有效" : "档案停用"}</StatusBadge>
                  <Button disabled={busy || !person.active} onClick={() => void addAlias(person)}>新增别名</Button>
                  {person.aliases.filter((alias) => alias.revokedAt === null).map((alias) => (
                    <button className="workforce-alias" key={alias.aliasId} disabled={busy} onClick={() => void revokeAlias(alias.aliasId)}>{alias.alias} ×</button>
                  ))}
                </article>
              ))}
            </div>
          </Surface>

          <Surface>
            <h2>临时工</h2>
            <div className="workforce-list">
              {temporary.length === 0 ? <p>{query.trim() ? "没有匹配的临时工。" : "暂无临时工档案。"}</p> : temporary.map((person) => (
                <article key={person.personId}>
                  <div><b>{person.displayName}</b><small>临时工 · 不登录 · {person.temporaryCode ?? "历史临时工待补编号"}{person.temporaryRemark ? ` · ${person.temporaryRemark}` : ""}</small></div>
                  <StatusBadge tone={person.active ? "success" : "warning"}>{person.active ? "可分配" : "已停用"}</StatusBadge>
                  <div className="workforce-row-actions">
                    <Button disabled={busy || !person.active} onClick={() => void addAlias(person)}>新增别名</Button>
                    <Button disabled={busy || !person.active} onClick={() => void deactivateTemporary(person)}>停用</Button>
                  </div>
                  <div className="workforce-aliases">
                    {person.aliases.filter((alias) => alias.revokedAt === null).map((alias) => (
                      <button className="workforce-alias" key={alias.aliasId} disabled={busy} onClick={() => void revokeAlias(alias.aliasId)}>{alias.alias} ×</button>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          </Surface>
        </div>
      </div>
    </Shell>
  );
}
