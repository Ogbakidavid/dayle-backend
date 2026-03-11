import { Pool } from 'pg';
import 'dotenv/config';

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    console.log('--- Querying Vault table structure via pg ---');
    const res = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'Vault'
      ORDER BY column_name;
    `);
    console.log('Columns found:');
    res.rows.forEach(row => {
      console.log(`- ${row.column_name} (${row.data_type})`);
    });

    console.log('\n--- Querying Deliverable table structure via pg ---');
    const dRes = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'Deliverable'
      ORDER BY column_name;
    `);
    console.log('Columns found:');
    dRes.rows.forEach(row => {
      console.log(`- ${row.column_name} (${row.data_type})`);
    });

    console.log('\n--- Checking for RLS policies on Vault ---');
    const rlsRes = await pool.query(`
      SELECT tablename, rowsecurity 
      FROM pg_tables 
      WHERE tablename = 'Vault' OR tablename = 'Deliverable';
    `);
    console.log(JSON.stringify(rlsRes.rows, null, 2));

  } catch (err) {
    console.error('Error:', err);
  } finally {
    await pool.end();
  }
}

main();
