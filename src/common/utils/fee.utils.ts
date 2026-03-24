/**
 * Calculates Dayle's tiered platform fee based on the vault amount in USD.
 * 
 * Fees:
 * $0 to $500: 5% Settlement + 0.5% Processing = 5.5% Total
 * $501 to $2,000: 4% Settlement + 0.5% Processing = 4.5% Total
 * $2,001 to $10,000: 3% Settlement + 0.5% Processing = 3.5% Total
 * $10,001 and above: 2.5% Settlement + 0.5% Processing = 3% Total
 * 
 * @param vaultAmountUSD The total amount in the vault in USD
 * @returns Object containing fee breakdown and amounts in USD
 */
export function calculateDayleFee(vaultAmountUSD: number) {
  let settlementFeePercent: number;
  
  if (vaultAmountUSD <= 500) {
    settlementFeePercent = 5;
  } else if (vaultAmountUSD <= 2000) {
    settlementFeePercent = 4;
  } else if (vaultAmountUSD <= 10000) {
    settlementFeePercent = 3;
  } else {
    settlementFeePercent = 2.5;
  }

  const processingFeePercent = 0.5;
  const totalFeePercent = settlementFeePercent + processingFeePercent;
  
  // Calculate USD amounts
  const settlementFeeUSD = Number(((vaultAmountUSD * settlementFeePercent) / 100).toFixed(2));
  const totalFeeUSD = settlementFeeUSD;
  const freelancerReceivesUSD = Number((vaultAmountUSD - totalFeeUSD).toFixed(2));

  // Basis points for smart contract (Settlement fee)
  const totalFeeBasisPoints = Math.round(totalFeePercent * 100);

  return {
    settlementFeePercent,
    totalFeePercent,
    settlementFeeUSD,
    totalFeeUSD,
    freelancerReceivesUSD,
    totalFeeBasisPoints,
  };
}
