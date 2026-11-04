package dev.ssp.bridge;

import org.bukkit.entity.Player;
import org.bukkit.inventory.ItemStack;

/** Implement in a backpack/plugin adapter, then register with SSPBridgePlugin.
 * Every method is called on the Minecraft main thread. Return only the selected
 * player's server-authoritative container; preserve custom components/NBT.
 */
public interface InventoryProvider {
    String id();
    String label();
    int capacity(Player player);
    ItemStack[] contents(Player player);
    void replaceContents(Player player, ItemStack[] contents);
    default boolean writable() { return true; }
}
