const { ethers } = require("ethers");
require("dotenv").config();

async function main() {
    const provider = new ethers.JsonRpcProvider("https://forno.celo-sepolia.celo-testnet.org");
    const privateKey = process.env.TREASURY_PRIVATE_KEY;
    const wallet = new ethers.Wallet(privateKey, provider);
    
    console.log("Using Wallet Address:", wallet.address);

    const mockCusdAddress = "0xEF4d55D6dE8e8d73232827Cd1e9b2F2dBb45bC80";
    const abi = ["function mint(address to, uint256 amount) external", "function balanceOf(address owner) view returns (uint256)"];
    
    // We are going to connect with the Treasury Wallet and mind Mock cUSD to itself!
    const contract = new ethers.Contract(mockCusdAddress, abi, wallet);
    
    console.log("Minting 10,000 Mock cUSD to Treasury...");
    
    try {
        const tx = await contract.mint(wallet.address, ethers.parseUnits("10000", 18));
        console.log("Transaction Hash:", tx.hash);
        console.log("Waiting for confirmation...");
        await tx.wait();
        
        const balance = await contract.balanceOf(wallet.address);
        console.log("New Mock cUSD Balance:", ethers.formatUnits(balance, 18));
    } catch(e) {
        console.error("Minting failed:", e);
    }
}
main().catch(console.error);
