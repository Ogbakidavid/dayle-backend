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
  const settlementFeeUSD = Number(
    ((vaultAmountUSD * settlementFeePercent) / 100).toFixed(2),
  );
  const processingFeeUSD = Number(
    ((vaultAmountUSD * processingFeePercent) / 100).toFixed(2),
  );
  const totalFeeUSD = Number((settlementFeeUSD + processingFeeUSD).toFixed(2));
  const freelancerReceivesUSD = Number(
    (vaultAmountUSD - settlementFeeUSD).toFixed(2),
  );

  // Basis points for smart contract (Settlement fee ONLY)
  // Processing fee is collected during onramp, and doesn't enter the smart contract
  const totalFeeBasisPoints = Math.round(settlementFeePercent * 100);

  return {
    settlementFeePercent,
    processingFeePercent,
    totalFeePercent,
    settlementFeeUSD,
    processingFeeUSD,
    totalFeeUSD,
    freelancerReceivesUSD,
    totalFeeBasisPoints,
  };
}
