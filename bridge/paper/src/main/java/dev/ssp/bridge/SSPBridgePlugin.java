package dev.ssp.bridge;

import com.google.gson.*;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.bukkit.*;
import org.bukkit.entity.Player;
import org.bukkit.event.*;
import org.bukkit.event.player.*;
import org.bukkit.event.server.ServerCommandEvent;
import org.bukkit.inventory.ItemStack;
import org.bukkit.plugin.java.JavaPlugin;

import java.io.*;
import java.lang.management.ManagementFactory;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.*;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;

public final class SSPBridgePlugin extends JavaPlugin implements Listener {
    private final Gson gson = new Gson();
    private final Deque<Map<String, Object>> chat = new ConcurrentLinkedDeque<>();
    private final Map<String, InventoryProvider> providers = new LinkedHashMap<>();
    private final Map<String, Map<String, Object>> known = new LinkedHashMap<>();
    private final Map<String, String> roles = new HashMap<>();
    private HttpServer http;
    private ExecutorService executor;
    private byte[] authorization;

    @Override public void onEnable() {
        saveDefaultConfig();
        String token = getConfig().getString("token", "");
        if (!token.matches("[A-Za-z0-9_-]{32,256}")) {
            byte[] bytes = new byte[32]; new SecureRandom().nextBytes(bytes);
            token = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
            getConfig().set("token", token); saveConfig();
            getLogger().info("SSP köprü anahtarı config.yml dosyasında oluşturuldu; dosya izinlerini 600 olarak ayarlayın.");
        }
        authorization = ("Bearer " + token).getBytes(StandardCharsets.UTF_8);
        loadKnown();
        registerInventoryProvider(new InventoryProvider() {
            public String id() { return "main"; }
            public String label() { return "Ana envanter"; }
            public int capacity(Player player) { return player.getInventory().getContents().length; }
            public ItemStack[] contents(Player player) { return player.getInventory().getContents(); }
            public void replaceContents(Player player, ItemStack[] items) { player.getInventory().setContents(items); player.updateInventory(); }
        });
        registerInventoryProvider(new InventoryProvider() {
            public String id() { return "ender_chest"; }
            public String label() { return "Ender sandığı"; }
            public int capacity(Player player) { return player.getEnderChest().getSize(); }
            public ItemStack[] contents(Player player) { return player.getEnderChest().getContents(); }
            public void replaceContents(Player player, ItemStack[] items) { player.getEnderChest().setContents(items); }
        });
        Bukkit.getPluginManager().registerEvents(this, this);
        Bukkit.getScheduler().runTaskTimer(this, this::saveKnown, 1200L, 1200L);
        try {
            http = HttpServer.create(new InetSocketAddress("127.0.0.1", getConfig().getInt("port", 8787)), 16);
            executor = new ThreadPoolExecutor(2, 4, 30, TimeUnit.SECONDS, new ArrayBlockingQueue<>(32), new ThreadPoolExecutor.AbortPolicy());
            http.setExecutor(executor); http.createContext("/", this::handle); http.start();
            getLogger().info("SSP oyuncu sağlayıcısı yalnızca localhost üzerinde hazır.");
        } catch (IOException error) {
            getLogger().severe("SSP HTTP sağlayıcısı başlatılamadı: portu kontrol edin.");
            Bukkit.getPluginManager().disablePlugin(this);
        }
    }

    @Override public void onDisable() {
        if (http != null) http.stop(1);
        if (executor != null) executor.shutdownNow();
        saveKnown();
    }

    public void registerInventoryProvider(InventoryProvider provider) {
        if (!Bukkit.isPrimaryThread()) throw new IllegalStateException("Register on the server main thread");
        if (!provider.id().matches("[a-z][a-z0-9_-]{0,31}")) throw new IllegalArgumentException("Invalid provider id");
        if (providers.containsKey(provider.id())) throw new IllegalArgumentException("Provider already registered");
        providers.put(provider.id(), provider);
    }
    public void unregisterInventoryProvider(String id) { if (!id.equals("main")) providers.remove(id); }

    private void handle(HttpExchange exchange) throws IOException {
        Future<Object> task = null;
        try {
            byte[] supplied = exchange.getRequestHeaders().getFirst("Authorization") == null ? new byte[0] : exchange.getRequestHeaders().getFirst("Authorization").getBytes(StandardCharsets.UTF_8);
            if (!MessageDigest.isEqual(authorization, supplied)) { reply(exchange, 401, Map.of("error", "Yetkisiz oyun sağlayıcısı isteği.")); return; }
            String method = exchange.getRequestMethod();
            String path = exchange.getRequestURI().getPath();
            JsonObject body = new JsonObject();
            if (Set.of("POST", "PUT", "PATCH").contains(method)) {
                String contentType = exchange.getRequestHeaders().getFirst("Content-Type");
                if (contentType == null || !contentType.startsWith("application/json")) throw new ApiError(415, "JSON içerik türü gerekli.");
                byte[] raw = exchange.getRequestBody().readNBytes(1024 * 1024 + 1);
                if (raw.length > 1024 * 1024) throw new ApiError(413, "İstek gövdesi çok büyük.");
                body = JsonParser.parseString(new String(raw, StandardCharsets.UTF_8)).getAsJsonObject();
            }
            final JsonObject input = body;
            task = Bukkit.getScheduler().callSyncMethod(this, () -> route(method, path, exchange.getRequestURI().getRawQuery(), input));
            Object response = task.get(8, TimeUnit.SECONDS);
            reply(exchange, 200, response);
        } catch (ExecutionException error) {
            Throwable cause = error.getCause();
            if (cause instanceof ApiError api) reply(exchange, api.status, Map.of("error", api.getMessage()));
            else reply(exchange, 500, Map.of("error", "Oyun sağlayıcısı işlemi tamamlayamadı."));
        } catch (ApiError error) {
            reply(exchange, error.status, Map.of("error", error.getMessage()));
        } catch (TimeoutException error) {
            if (task != null) task.cancel(false);
            reply(exchange, 503, Map.of("error", "Minecraft ana iş parçacığı yanıt vermedi."));
        } catch (Exception error) {
            reply(exchange, 400, Map.of("error", "Geçersiz oyun sağlayıcısı isteği."));
        } finally { exchange.close(); }
    }

    private Object route(String method, String path, String query, JsonObject body) {
        if (method.equals("GET") && (path.equals("/state") || path.equals("/snapshot"))) return snapshot();
        if (method.equals("POST") && path.equals("/chat")) {
            String message = string(body, "message", 500);
            Bukkit.broadcastMessage("[SSP] " + message);
            recordChat("SSP", null, "global", message);
            return Map.of("accepted", true);
        }
        String[] pieces = path.split("/");
        if (pieces.length < 3 || !pieces[1].equals("players")) throw new ApiError(404, "Sağlayıcı yolu bulunamadı.");
        UUID uuid;
        try { uuid = UUID.fromString(pieces[2]); } catch (IllegalArgumentException error) { throw new ApiError(400, "Oyuncu UUID geçersiz."); }
        OfflinePlayer offline = Bukkit.getOfflinePlayer(uuid);
        if (!offline.hasPlayedBefore() && !offline.isOnline()) throw new ApiError(404, "Oyuncu bu sunucuda bulunamadı.");
        if (pieces.length == 3 && method.equals("PATCH")) {
            if (body.has("role")) {
                String role = string(body, "role", 16);
                if (!Set.of("player", "moderator", "admin").contains(role)) throw new ApiError(400, "Geçersiz yetki.");
                String permissionCommand = getConfig().getString(role + "-command", "");
                if (role.equals("moderator") && permissionCommand.isBlank()) throw new ApiError(409, "Moderatör yetkisi için config.yml içinde permissions eklentisi komutu tanımlayın.");
                String priorRole = offline.isOp() ? "admin" : roles.getOrDefault(uuid.toString(), "player");
                if (!priorRole.equals(role) && !getConfig().getString(priorRole + "-command", "").isBlank() && permissionCommand.isBlank()) throw new ApiError(409, "Önce hedef rolün permissions eklentisi komutunu yapılandırın; mevcut grup sessizce korunmaz.");
                if (!permissionCommand.isBlank()) {
                    if (!Bukkit.dispatchCommand(Bukkit.getConsoleSender(), permissionCommand.replace("{uuid}", uuid.toString()).replace("{name}", Objects.requireNonNullElse(offline.getName(), uuid.toString())))) throw new ApiError(409, "Yetki eklentisi komutu uygulanamadı.");
                }
                offline.setOp(permissionCommand.isBlank() && role.equals("admin"));
                roles.put(uuid.toString(), role);
            }
            if (body.has("banned")) {
                boolean banned = body.get("banned").getAsBoolean();
                if (banned) {
                    offline.ban("SSP panel", (Date) null, "SSP");
                    if (offline.isOnline()) Objects.requireNonNull(offline.getPlayer()).kickPlayer("SSP: Sunucudan yasaklandınız.");
                } else Bukkit.getBanList(io.papermc.paper.ban.BanListType.PROFILE).pardon(offline.getPlayerProfile());
            }
            saveKnown();
            return playerData(offline);
        }
        if (pieces.length == 4 && pieces[3].equals("inventory") && Set.of("GET", "PUT").contains(method)) {
            Player player = offline.getPlayer();
            if (player == null) throw new ApiError(409, "Envanter erişimi için oyuncu çevrimiçi olmalıdır. Çevrimdışı NBT dosyasına güvenli olmayan yazma yapılmaz.");
            String id = queryValue(query, "provider", "main");
            InventoryProvider provider = providers.get(id);
            if (provider == null) throw new ApiError(409, "Bu çanta/mod için bir SSP envanter sağlayıcısı yüklü değil.");
            int capacity = provider.capacity(player);
            if (capacity < 1 || capacity > 256) throw new ApiError(409, "Sağlayıcı envanter boyutu geçersiz.");
            if (method.equals("PUT")) {
                if (!provider.writable()) throw new ApiError(403, "Bu envanter salt okunur.");
                JsonArray slots = body.getAsJsonArray("slots");
                if (slots == null || slots.size() > capacity) throw new ApiError(400, "Envanter yuvaları geçersiz.");
                ItemStack[] replacement = new ItemStack[capacity];
                Set<Integer> seen = new HashSet<>();
                for (JsonElement element : slots) {
                    JsonObject slot = element.getAsJsonObject();
                    int index = slot.get("slot").getAsInt();
                    if (index < 0 || index >= capacity || !seen.add(index)) throw new ApiError(400, "Yuva numarası geçersiz veya yineleniyor.");
                    String itemName = string(slot, "item", 100).toUpperCase(Locale.ROOT).replace("MINECRAFT:", "");
                    Material material = Material.matchMaterial(itemName);
                    int count = slot.get("count").getAsInt();
                    if (material == null || !material.isItem() || count < 0 || count > material.getMaxStackSize()) throw new ApiError(400, "Eşya türü veya miktarı geçersiz.");
                    if (material.isAir() || count == 0) continue;
                    ItemStack item = new ItemStack(material, count);
                    if (slot.has("data")) {
                        String encoded = string(slot, "data", 131072);
                        try { item = ItemStack.deserializeBytes(Base64.getDecoder().decode(encoded)); } catch (RuntimeException error) { throw new ApiError(400, "Özel eşya verisi geçersiz."); }
                        if (item.getType() != material) throw new ApiError(400, "Özel eşya türü değiştirilemez; yeni eşya için özel veriyi kaldırın.");
                        item.setAmount(count);
                    }
                    replacement[index] = item;
                }
                provider.replaceContents(player, replacement);
            }
            List<Map<String, Object>> slots = new ArrayList<>();
            ItemStack[] items = provider.contents(player);
            for (int index = 0; index < Math.min(items.length, capacity); index++) {
                ItemStack item = items[index];
                if (item == null || item.getType().isAir()) continue;
                slots.add(Map.of("slot", index, "item", item.getType().getKey().toString(), "count", item.getAmount(), "data", Base64.getEncoder().encodeToString(item.serializeAsBytes())));
            }
            return Map.of("provider", id, "slots", slots, "capacity", capacity, "writable", provider.writable());
        }
        throw new ApiError(404, "Sağlayıcı yolu bulunamadı.");
    }

    private Map<String, Object> playerData(OfflinePlayer offline) {
        String id = offline.getUniqueId().toString();
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("uuid", id); value.put("name", Objects.requireNonNullElse(offline.getName(), id));
        value.put("online", offline.isOnline()); value.put("banned", offline.isBanned());
        value.put("role", offline.isOp() ? "admin" : roles.getOrDefault(id, "player"));
        value.put("ping", offline.isOnline() ? Objects.requireNonNull(offline.getPlayer()).getPing() : 0);
        int ticks = 0; try { ticks = offline.getStatistic(Statistic.PLAY_ONE_MINUTE); } catch (RuntimeException ignored) {}
        value.put("playTime", ticks / 20L);
        known.put(id, value);
        return value;
    }
    private Object snapshot() {
        List<Map<String, Object>> players = new ArrayList<>();
        for (OfflinePlayer offline : Bukkit.getOfflinePlayers()) players.add(playerData(offline));
        List<Map<String, Object>> inventories = providers.values().stream().map(provider -> Map.<String, Object>of("id", provider.id(), "label", provider.label(), "writable", provider.writable())).toList();
        Runtime runtime = Runtime.getRuntime();
        Map<String, Object> metrics = new LinkedHashMap<>();
        metrics.put("memory", (runtime.totalMemory() - runtime.freeMemory()) / 1073741824.0);
        metrics.put("memoryTotal", runtime.maxMemory() / 1073741824.0);
        metrics.put("tps", Bukkit.getTPS()[0]); metrics.put("uptime", ManagementFactory.getRuntimeMXBean().getUptime() / 1000);
        metrics.put("disk", (getServer().getWorldContainer().getTotalSpace() - getServer().getWorldContainer().getUsableSpace()) / 1073741824.0);
        metrics.put("diskTotal", getServer().getWorldContainer().getTotalSpace() / 1073741824.0);
        metrics.put("cpu", null); metrics.put("networkIn", null); metrics.put("networkOut", null);
        return Map.of("status", "running", "players", players, "chat", new ArrayList<>(chat), "mods", List.of(), "console", List.of(), "metrics", metrics, "inventoryProviders", inventories);
    }
    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onChat(AsyncPlayerChatEvent event) { recordChat(event.getPlayer().getName(), null, "global", event.getMessage()); }
    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onCommand(PlayerCommandPreprocessEvent event) {
        String[] parts = event.getMessage().split(" ", 3);
        String verb = parts[0].toLowerCase(Locale.ROOT).replaceFirst("^/", "");
        if (Set.of("msg", "tell", "w", "whisper", "minecraft:msg", "minecraft:tell", "minecraft:w").contains(verb) && parts.length == 3) recordChat(event.getPlayer().getName(), parts[1], "whisper", parts[2]);
        else recordChat(event.getPlayer().getName(), null, "command", sensitive(verb) ? "/" + verb + " [gizli parametreler]" : event.getMessage());
    }
    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onServerCommand(ServerCommandEvent event) {
        String verb = event.getCommand().split(" ", 2)[0].toLowerCase(Locale.ROOT);
        recordChat("Konsol", null, "command", sensitive(verb) ? verb + " [gizli parametreler]" : event.getCommand());
    }
    private boolean sensitive(String verb) { return Set.of("login", "register", "changepassword", "auth", "password", "l", "reg").contains(verb); }
    private void recordChat(String player, String recipient, String type, String message) {
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("id", UUID.randomUUID().toString()); entry.put("player", player); entry.put("recipient", recipient);
        entry.put("type", type); entry.put("message", message); entry.put("timestamp", Instant.now().toString());
        chat.addLast(entry); while (chat.size() > 1000) chat.pollFirst();
    }
    private void loadKnown() {
        Path file = getDataFolder().toPath().resolve("players.json");
        if (!Files.exists(file)) return;
        try {
            JsonObject value = JsonParser.parseString(Files.readString(file)).getAsJsonObject();
            JsonObject savedRoles = value.getAsJsonObject("roles");
            if (savedRoles != null) for (String uuid : savedRoles.keySet()) roles.put(uuid, savedRoles.get(uuid).getAsString());
        } catch (Exception ignored) { getLogger().warning("SSP oyuncu yetki kaydı okunamadı."); }
    }
    private void saveKnown() {
        try { Files.writeString(getDataFolder().toPath().resolve("players.json"), gson.toJson(Map.of("roles", roles, "players", known)), StandardCharsets.UTF_8); }
        catch (IOException ignored) { getLogger().warning("SSP oyuncu kaydı yazılamadı."); }
    }
    private String string(JsonObject value, String field, int max) {
        if (!value.has(field) || !value.get(field).isJsonPrimitive() || !value.get(field).getAsJsonPrimitive().isString()) throw new ApiError(400, field + " gerekli.");
        String text = value.get(field).getAsString();
        if (text.isBlank() || text.length() > max || text.indexOf('\u0000') >= 0) throw new ApiError(400, field + " geçersiz.");
        return text;
    }
    private String queryValue(String query, String name, String fallback) {
        if (query != null) for (String item : query.split("&")) {
            String[] pair = item.split("=", 2);
            if (URLDecoder.decode(pair[0], StandardCharsets.UTF_8).equals(name) && pair.length == 2) return URLDecoder.decode(pair[1], StandardCharsets.UTF_8);
        }
        return fallback;
    }
    private void reply(HttpExchange exchange, int status, Object value) throws IOException {
        byte[] payload = gson.toJson(value).getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.sendResponseHeaders(status, payload.length); exchange.getResponseBody().write(payload);
    }
    private static final class ApiError extends RuntimeException {
        final int status;
        ApiError(int status, String message) { super(message); this.status = status; }
    }
}
