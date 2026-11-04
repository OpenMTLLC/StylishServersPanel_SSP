package dev.ssp.bridge;

import java.util.function.Function;
import org.bukkit.entity.Player;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.ItemStack;

/** Adapter for a backpack plugin that exposes a server-authoritative Bukkit Inventory.
 * The owning backpack plugin supplies its real inventory lookup; SSP never guesses
 * a mod's NBT layout. Register after SSPBridge is enabled (softdepend: [SSPBridge]).
 */
public final class BukkitContainerProvider implements InventoryProvider {
    private final String id;
    private final String label;
    private final Function<Player, Inventory> lookup;
    public BukkitContainerProvider(String id, String label, Function<Player, Inventory> lookup) {
        this.id = id; this.label = label; this.lookup = lookup;
    }
    public String id() { return id; }
    public String label() { return label; }
    private Inventory inventory(Player player) {
        Inventory value = lookup.apply(player);
        if (value == null) throw new IllegalStateException("No server-authoritative backpack for player");
        return value;
    }
    public int capacity(Player player) { return inventory(player).getSize(); }
    public ItemStack[] contents(Player player) { return inventory(player).getContents(); }
    public void replaceContents(Player player, ItemStack[] items) { inventory(player).setContents(items); }
}
