const { ethers } = require("ethers");
require("dotenv").config({ path: "/home/creativeogbaki/Desktop/dayle-smart-contract/.env" });

async function main() {
    const provider = new ethers.JsonRpcProvider("https://forno.celo-sepolia.celo-testnet.org");
    const devPrivateKey = process.env.PRIVATE_KEY;
    const devWallet = new ethers.Wallet(devPrivateKey, provider);
    
    console.log("Dev Wallet Address:", devWallet.address);

    const mockCusdAddress = "0xEF4d55D6dE8e8d73232827Cd1e9b2F2dBb45bC80";
    const abi = ["function transfer(address to, uint256 amount) external returns (bool)", "function balanceOf(address owner) view returns (uint256)"];
    
    const contract = new ethers.Contract(mockCusdAddress, abi, devWallet);
    const balance = await contract.balanceOf(devWallet.address);
    console.log("Dev Mock cUSD Balance:", ethers.formatUnits(balance, 18));
    
    if (balance > 0n) {
        console.log("Transferring 10,000 Mock cUSD to Treasury...");
        const treasury = "0x54a28bf7229570f7E7d9C2855B4c81dA9760380e";
        const tx = await contract.transfer(treasury, ethers.parseUnits("10000", 18));
        console.log("Tx Hash:", tx.hash);
        await tx.wait();
        console.log("Transfer complete.");
        
        const treasuryBalance = await contract.balanceOf(treasury);
        console.log("Treasury Mock cUSD Balance:", ethers.formatUnits(treasuryBalance, 18));
    } else {
        console.log("Dev wallet has no Mock cUSD.");
    }
}
main().catch(console.error);
