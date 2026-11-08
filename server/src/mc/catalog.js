// Curated, one-click plugins. Slugs are Modrinth project slugs; `alt` lists other slugs for the same thing,
// because maintained forks move around. Whatever Modrinth doesn't have for the server's version is hidden at runtime,
// so a renamed or missing project never shows up as a dead button.
export const CATEGORIES = [
  { id: "economy", label: "Economy & shops", blurb: "Money, shops and player trading" },
  { id: "ranks", label: "Permissions & ranks", blurb: "Who can do what, and the ranks players see" },
  { id: "protect", label: "Protection & anti-grief", blurb: "Claims, regions and rollback" },
  { id: "libs", label: "APIs & libraries", blurb: "The building blocks other plugins ask for" },
  { id: "web", label: "Maps, stats & web", blurb: "Live map and player analytics you can put on a website" },
  { id: "join", label: "Join & cross-play", blurb: "Let more people on: other versions, Bedrock" },
  { id: "tools", label: "Admin tools", blurb: "Pregenerate worlds, find lag, build faster" },
  { id: "chat", label: "Chat & social", blurb: "Chat formatting, tab list, voice, Discord links" },
  { id: "world", label: "Worlds & travel", blurb: "Multiple worlds, teleports, map tools" },
  { id: "fun", label: "Gameplay & fun", blurb: "Crates, jobs, rewards, extra mechanics" },
];

export const CATALOG = [
  { slug: "essentialsx", category: "economy", title: "EssentialsX", blurb: "Homes, warps, kits, /spawn, /pay and a basic economy. The standard starter pack." },
  { slug: "vault", alt: ["vaultunlocked"], category: "economy", title: "Vault", blurb: "The bridge between economy, permissions and chat plugins. Most shop plugins need it." },
  { slug: "quickshop-hikari", category: "economy", title: "QuickShop-Hikari", blurb: "Players sell items with chest shops: hit a chest with the item and set a price." },
  { slug: "luckperms", category: "ranks", title: "LuckPerms", blurb: "Ranks and permissions with an easy web editor. Install this first on any serious server." },
  { slug: "worldguard", category: "protect", title: "WorldGuard", blurb: "Protect regions: spawn, shops, arenas. Control pvp, mobs, building.", needs: ["worldedit"] },
  { slug: "coreprotect", category: "protect", title: "CoreProtect", blurb: "Logs every block change so you can inspect and roll back griefing." },
  { slug: "huskclaims", category: "protect", title: "HuskClaims", blurb: "Players claim land with a golden shovel. Trust lists and admin claims." },
  { slug: "placeholderapi", category: "libs", title: "PlaceholderAPI", blurb: "Lets plugins show each other's data in chat, scoreboards and signs." },
  { slug: "protocollib", category: "libs", title: "ProtocolLib", blurb: "Packet library many plugins depend on." },
  { slug: "worldedit", category: "tools", title: "WorldEdit", blurb: "Build tools: copy, paste, fill and brush big areas." },
  { slug: "chunky", category: "tools", title: "Chunky", blurb: "Pregenerate the world so exploring doesn't lag the server." },
  { slug: "spark", category: "tools", title: "spark", blurb: "Profiler: finds what is causing lag." },
  { slug: "dynmap", category: "web", title: "Dynmap", blurb: "A live Google-Maps-style map of your world in the browser (port 8123)." },
  { slug: "bluemap", category: "web", title: "BlueMap", blurb: "A prettier 3D live map in the browser (port 8100)." },
  { slug: "plan", alt: ["plan-player-analytics"], category: "web", title: "Plan", blurb: "Player analytics dashboard: who plays, when, for how long (web page on port 8804)." },
  { slug: "viaversion", category: "join", title: "ViaVersion", blurb: "Lets players on newer Minecraft versions join." },
  { slug: "geyser", category: "join", title: "Geyser", blurb: "Lets Bedrock players (phones, consoles, Windows 10) join your Java server." },
  { slug: "viabackwards", category: "join", title: "ViaBackwards", blurb: "Lets players on older Minecraft versions join. Pair with ViaVersion.", needs: ["viaversion"] },
  { slug: "squaremap", category: "web", title: "squaremap", blurb: "Lightweight, fast live map in the browser. Good if Dynmap is too heavy." },
  { slug: "tab", category: "chat", title: "TAB", blurb: "Custom tab list, nametags and scoreboard with ranks and ping." },
  { slug: "chatty", alt: ["chatty-bukkit"], category: "chat", title: "Chatty", blurb: "Chat formats, prefixes and per-world or ranged chat." },
  { slug: "simple-voice-chat", category: "chat", title: "Simple Voice Chat", blurb: "Proximity voice chat. Players also need the mod or a compatible client; opens a UDP port (24454)." },
  { slug: "discordsrv", category: "chat", title: "DiscordSRV", blurb: "Two-way chat bridge between in-game and a Discord channel." },
  { slug: "multiverse-core", category: "world", title: "Multiverse-Core", blurb: "Run several worlds (survival, creative, minigames) and hop between them." },
  { slug: "chunky-border", category: "world", title: "Chunky Border", blurb: "Set a world border and keep players inside it. Pairs with Chunky.", needs: ["chunky"] },
  { slug: "betterrtp", alt: ["better-rtp"], category: "world", title: "BetterRTP", blurb: "/rtp random teleport so players spread out instead of camping spawn." },
  { slug: "griefprevention", category: "protect", title: "GriefPrevention", blurb: "The classic land claim plugin: golden shovel claims and trust." },
  { slug: "lwc", alt: ["lwc-extended", "lwcx"], category: "protect", title: "LWC", blurb: "Lock chests, doors and furnaces to their owner." },
  { slug: "jobs-reborn", alt: ["jobsreborn"], category: "fun", title: "Jobs Reborn", blurb: "Miner, farmer, hunter: players earn money for what they do." },
  { slug: "excellentcrates", category: "fun", title: "ExcellentCrates", blurb: "Crates and keys with animated openings, for rewards and store perks." },
  { slug: "mcmmo", category: "fun", title: "mcMMO", blurb: "RPG skills that level as players mine, fight and fish." },
  { slug: "votifier", alt: ["nuvotifier"], category: "fun", title: "NuVotifier", blurb: "Receive votes from server-list sites so you can reward voters." },
  { slug: "floodgate", category: "join", title: "Floodgate", blurb: "Bedrock players join without needing a Java account. Pair with Geyser.", needs: ["geyser"] },
];

// One click, a few plugins that belong together.
export const BUNDLES = [
  { id: "economy", title: "Economy starter", blurb: "Vault + EssentialsX + QuickShop: money, /pay, and player shops.", slugs: ["vault", "essentialsx", "quickshop-hikari"] },
  { id: "survival", title: "Survival essentials", blurb: "LuckPerms + EssentialsX + CoreProtect + HuskClaims.", slugs: ["luckperms", "essentialsx", "coreprotect", "huskclaims"] },
  { id: "staff", title: "Staff toolkit", blurb: "LuckPerms ranks + CoreProtect rollback + spark profiler + WorldEdit: what moderators and builders need.", slugs: ["luckperms", "coreprotect", "spark", "worldedit"] },
  { id: "golive", title: "Ready for real players", blurb: "Ranks, rollback for grief, region protection, essentials and a lag profiler.", slugs: ["luckperms", "essentialsx", "vault", "coreprotect", "worldguard", "spark"] },
  { id: "social", title: "Social server", blurb: "TAB + Chatty + Simple Voice Chat + DiscordSRV: a server that feels alive.", slugs: ["tab", "chatty", "simple-voice-chat", "discordsrv"] },
  { id: "worlds", title: "Multi-world", blurb: "Multiverse + Chunky + BetterRTP: several worlds, pregenerated, with random teleport.", slugs: ["multiverse-core", "chunky", "betterrtp"] },
  { id: "bedrock", title: "Bedrock friendly", blurb: "Geyser + Floodgate + ViaVersion so almost anyone can join.", slugs: ["geyser", "floodgate", "viaversion"] },
];

export const catalogSlugs = () => new Set(CATALOG.flatMap((c) => [c.slug, ...(c.alt ?? [])]));
