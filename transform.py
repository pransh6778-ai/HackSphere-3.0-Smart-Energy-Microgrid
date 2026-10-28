import pandas as pd

# Load the raw telemetry data
df = pd.read_csv('train_telemetry.csv')

# Convert the timestamp string to a datetime object
df['timestamp'] = pd.to_datetime(df['timestamp'])

# Extract the hour (0-23) into a brand new numerical column
df['hour'] = df['timestamp'].dt.hour

# Ensure target_demand_kw is placed as the final column (QuickML tabular best practice)
if 'target_demand_kw' in df.columns:
    cols = [col for col in df.columns if col != 'target_demand_kw'] + ['target_demand_kw']
    df = df[cols]

# Save the newly transformed dataset
df.to_csv('train_telemetry_engineered.csv', index=False)
print("Dataset transformed successfully!")
