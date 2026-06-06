/// A minimal, self-contained fungible asset for the WDK Aptos TUI demo.
///
/// `init_module` runs once on publish and creates the FA under a named object,
/// so its metadata address is derived deterministically from the publisher
/// address and the `ASSET_SYMBOL` seed. The `MintRef` is kept in a resource at
/// the publisher address.
///
/// `mint` is an OPEN FAUCET: any caller may mint to any address with no admin
/// gate. This is intentional — it lets every TUI account self-fund test tokens
/// for the mint / airdrop / send demo without holding the publisher key. Do NOT
/// reuse this pattern for a real asset.
module demo_fa::demo_fa {
    use aptos_framework::fungible_asset::{Self, MintRef, TransferRef, BurnRef, Metadata};
    use aptos_framework::object::{Self, Object};
    use aptos_framework::primary_fungible_store;
    use std::option;
    use std::string::utf8;

    /// Holds the asset's control refs, stored at the publisher address.
    struct ManagedFungibleAsset has key {
        mint_ref: MintRef,
        transfer_ref: TransferRef,
        burn_ref: BurnRef,
    }

    /// The object seed for the FA metadata. The on-chain metadata address is
    /// `object::create_object_address(&publisher, ASSET_SYMBOL)`.
    const ASSET_SYMBOL: vector<u8> = b"WDKT";

    const ASSET_NAME: vector<u8> = b"WDK Demo Token";
    const ASSET_DECIMALS: u8 = 6;

    /// Runs automatically when the module is published.
    fun init_module(publisher: &signer) {
        let constructor_ref = &object::create_named_object(publisher, ASSET_SYMBOL);

        primary_fungible_store::create_primary_store_enabled_fungible_asset(
            constructor_ref,
            option::none(), // no maximum supply
            utf8(ASSET_NAME),
            utf8(ASSET_SYMBOL),
            ASSET_DECIMALS,
            utf8(b"https://tether.to/images/logoCircle.png"),
            utf8(b"https://github.com/tetherto/wdk"),
        );

        let mint_ref = fungible_asset::generate_mint_ref(constructor_ref);
        let transfer_ref = fungible_asset::generate_transfer_ref(constructor_ref);
        let burn_ref = fungible_asset::generate_burn_ref(constructor_ref);
        let metadata_signer = &object::generate_signer(constructor_ref);

        move_to(metadata_signer, ManagedFungibleAsset { mint_ref, transfer_ref, burn_ref });
    }

    #[view]
    /// Returns the metadata object of this demo FA.
    public fun get_metadata(): Object<Metadata> {
        let asset_address = object::create_object_address(&@demo_fa, ASSET_SYMBOL);
        object::address_to_object<Metadata>(asset_address)
    }

    /// OPEN FAUCET: mint `amount` base units of the demo FA to `to`.
    /// No admin check — any caller may invoke this.
    public entry fun mint(_caller: &signer, to: address, amount: u64) acquires ManagedFungibleAsset {
        let asset = get_metadata();
        let managed = borrow_global<ManagedFungibleAsset>(object::object_address(&asset));
        let store = primary_fungible_store::ensure_primary_store_exists(to, asset);
        fungible_asset::mint_to(&managed.mint_ref, store, amount);
    }
}
