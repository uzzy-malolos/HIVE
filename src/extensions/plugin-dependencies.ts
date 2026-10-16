import { pluginVersionSatisfies } from "./plugin-components.js";
import type { ExtensionCatalog, PluginDescriptor } from "./types.js";

/** Resolve installed declarations only. Dependency declarations never install or enable code. */
export function gatePluginDependencies(catalog: ExtensionCatalog): void {
  const reasons = new Map<string, string | undefined>();
  const visiting = new Set<string>();
  const reasonFor = (plugin: PluginDescriptor): string | undefined => {
    if (visiting.has(plugin.id)) return `Plugin dependency cycle involving ${plugin.id}`;
    if (reasons.has(plugin.id)) return reasons.get(plugin.id);
    visiting.add(plugin.id);
    let reason: string | undefined;
    for (const dependency of plugin.dependencies ?? []) {
      const marketplace = dependency.marketplace ?? plugin.marketplace;
      const candidates = catalog.plugins.filter((entry) => (entry.sourceName ?? entry.name) === dependency.name && (!marketplace || entry.marketplace === marketplace));
      const target = candidates.length === 1 ? candidates[0] : undefined;
      if (!target) { reason = `Plugin ${plugin.id} requires ${candidates.length ? "an unambiguous installed" : "installed"} dependency ${dependency.name}${marketplace ? `@${marketplace}` : ""}`; break; }
      if (dependency.version && !pluginVersionSatisfies(target.pluginVersion, dependency.version)) { reason = `Plugin ${plugin.id} requires ${target.id} version ${dependency.version}; installed version is ${target.pluginVersion ?? "undeclared"}`; break; }
      const nested = reasonFor(target);
      if (nested) { reason = nested; break; }
      if (!target.trusted || !target.enabled) { reason = `Plugin ${plugin.id} requires trusted, enabled dependency ${target.id}`; break; }
    }
    visiting.delete(plugin.id);
    reasons.set(plugin.id, reason);
    return reason;
  };
  for (const plugin of catalog.plugins) {
    const reason = reasonFor(plugin);
    if (!reason) continue;
    plugin.blockedReason = reason;
    for (const entry of [...catalog.servers, ...catalog.skills, ...catalog.hooks, ...catalog.agents, ...catalog.lspServers, ...catalog.outputStyles]) {
      if (entry.pluginId === plugin.id) entry.blockedReason = reason;
    }
  }
}
